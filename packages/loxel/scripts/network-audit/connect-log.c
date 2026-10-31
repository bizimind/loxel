// DYLD interposer for network audits: logs every socket attempt and DNS lookup of a process, and
// blocks any that would leave the machine, so auditing a binary cannot send anything either. It
// needs no root and, unlike a proxy or lsof sampling, misses neither proxy-ignoring clients nor
// short-lived sockets. Log lines are "<pid> <program> <kind> <target> <BLOCKED|local>".
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <resolv.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

extern const char *getprogname(void);

#define DYLD_INTERPOSE(_new, _old)                                                                 \
  __attribute__((used)) static struct {                                                            \
    const void *n;                                                                                 \
    const void *o;                                                                                 \
  } _interpose_##_old __attribute__((section("__DATA,__interpose"))) = {(const void *)_new,        \
                                                                        (const void *)_old};

static void logline(const char *kind, const char *what, const char *verdict) {
  const char *path = getenv("CONNECT_LOG");
  if (!path) return;
  int fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0644);
  if (fd < 0) return;
  char buf[512];
  int n = snprintf(buf, sizeof buf, "%d %s %s %s %s\n", getpid(), getprogname(), kind, what, verdict);
  write(fd, buf, n);
  close(fd);
}

// Proves the logger is in the process: a run with no other lines is otherwise indistinguishable
// from one where the dynamic linker never loaded it.
__attribute__((constructor)) static void on_load(void) { logline("loaded", "-", "local"); }

// Returns 1 when the address leaves the machine. Fills `what` with its text form.
static int describe(const struct sockaddr *a, char *what, size_t len) {
  char ip[INET6_ADDRSTRLEN] = "";
  if (!a) {
    snprintf(what, len, "(none)");
    return 0;
  }
  if (a->sa_family == AF_INET) {
    const struct sockaddr_in *v4 = (const struct sockaddr_in *)a;
    inet_ntop(AF_INET, &v4->sin_addr, ip, sizeof ip);
    snprintf(what, len, "%s:%d", ip, ntohs(v4->sin_port));
    return (ntohl(v4->sin_addr.s_addr) >> 24) != 127;
  }
  if (a->sa_family == AF_INET6) {
    const struct sockaddr_in6 *v6 = (const struct sockaddr_in6 *)a;
    inet_ntop(AF_INET6, &v6->sin6_addr, ip, sizeof ip);
    snprintf(what, len, "[%s]:%d", ip, ntohs(v6->sin6_port));
    return !IN6_IS_ADDR_LOOPBACK(&v6->sin6_addr);
  }
  if (a->sa_family == AF_UNIX) {
    snprintf(what, len, "unix:%s", ((const struct sockaddr_un *)a)->sun_path);
    return 0;
  }
  snprintf(what, len, "family:%d", a->sa_family);
  return 0;
}

static int my_connect(int fd, const struct sockaddr *a, socklen_t l) {
  char what[256];
  if (describe(a, what, sizeof what)) {
    logline("connect", what, "BLOCKED");
    errno = ECONNREFUSED;
    return -1;
  }
  logline("connect", what, "local");
  return connect(fd, a, l);
}
DYLD_INTERPOSE(my_connect, connect)

// .NET's sockets call these variants, which interposing `connect` does not reach.
extern int connect_nocancel(int, const struct sockaddr *, socklen_t) __asm("_connect$NOCANCEL");
static int my_connect_nocancel(int fd, const struct sockaddr *a, socklen_t l) {
  char what[256];
  if (describe(a, what, sizeof what)) {
    logline("connect", what, "BLOCKED");
    errno = ECONNREFUSED;
    return -1;
  }
  logline("connect", what, "local");
  return connect_nocancel(fd, a, l);
}
DYLD_INTERPOSE(my_connect_nocancel, connect_nocancel)

static int my_connectx(int fd, const sa_endpoints_t *e, sae_associd_t assoc, unsigned int flags,
                       const struct iovec *iov, unsigned int iovcnt, size_t *len,
                       sae_connid_t *conn) {
  char what[256];
  if (e && describe(e->sae_dstaddr, what, sizeof what)) {
    logline("connectx", what, "BLOCKED");
    errno = ECONNREFUSED;
    return -1;
  }
  return connectx(fd, e, assoc, flags, iov, iovcnt, len, conn);
}
DYLD_INTERPOSE(my_connectx, connectx)

static ssize_t my_sendto(int fd, const void *b, size_t n, int f, const struct sockaddr *a,
                         socklen_t l) {
  char what[256];
  if (a && describe(a, what, sizeof what)) {
    logline("sendto", what, "BLOCKED");
    errno = ENETUNREACH;
    return -1;
  }
  return sendto(fd, b, n, f, a, l);
}
DYLD_INTERPOSE(my_sendto, sendto)

extern ssize_t sendmsg_nocancel(int, const struct msghdr *, int) __asm("_sendmsg$NOCANCEL");
static ssize_t my_sendmsg_nocancel(int fd, const struct msghdr *m, int f) {
  char what[256];
  if (m && m->msg_name && describe((const struct sockaddr *)m->msg_name, what, sizeof what)) {
    logline("sendmsg", what, "BLOCKED");
    errno = ECONNREFUSED;
    return -1;
  }
  return sendmsg_nocancel(fd, m, f);
}
DYLD_INTERPOSE(my_sendmsg_nocancel, sendmsg_nocancel)

static int my_getaddrinfo(const char *h, const char *s, const struct addrinfo *hints,
                          struct addrinfo **res) {
  // Resolving a literal address or localhost stays on the machine (servers do it to listen).
  struct in6_addr parsed;
  if (!h || strcmp(h, "localhost") == 0 || inet_pton(AF_INET, h, &parsed) == 1 ||
      inet_pton(AF_INET6, h, &parsed) == 1) {
    return getaddrinfo(h, s, hints, res);
  }
  logline("getaddrinfo", h, "BLOCKED");
  return EAI_NONAME;
}
DYLD_INTERPOSE(my_getaddrinfo, getaddrinfo)

static int my_nsearch(res_state st, const char *name, int cls, int type, u_char *ans, int anslen) {
  logline("dns", name, "BLOCKED");
  return -1;
}
DYLD_INTERPOSE(my_nsearch, res_9_nsearch)

static int my_search(const char *name, int cls, int type, u_char *ans, int anslen) {
  logline("dns", name, "BLOCKED");
  return -1;
}
DYLD_INTERPOSE(my_search, res_search)

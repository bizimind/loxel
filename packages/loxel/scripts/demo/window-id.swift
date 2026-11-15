// Prints the window number (CGWindowID) of the largest on-screen window owned by a process, for
// `screencapture -l`. Usage: swift window-id.swift <pid>
import CoreGraphics

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) else {
  fputs("usage: swift window-id.swift <pid>\n", stderr)
  exit(2)
}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
  as? [[String: Any]] ?? []
let area = { (w: [String: Any]) -> Double in
  let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
  return (b["Width"] ?? 0) * (b["Height"] ?? 0)
}
let owned = windows.filter {
  ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
}
guard let window = owned.max(by: { area($0) < area($1) }), let id = window[kCGWindowNumber as String] else {
  fputs("no on-screen window for pid \(pid)\n", stderr)
  exit(1)
}
print(id)

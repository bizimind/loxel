import { wsClient } from "@/api/client";
import { javaToolchain } from "@/api/java-env-model";

import { createLspClient, restartStoppedLanguageServers } from "./lsp-client";

// A server that could not start for lack of a new enough JDK comes back when one is installed.
wsClient.subscribe((message) => {
  if (message.type === javaToolchain.changedMessage) restartStoppedLanguageServers();
});

// Eclipse JDT LS, on the user's JDK.
export default createLspClient({ route: "ws/java-lsp", name: "Java", languageId: "java" });

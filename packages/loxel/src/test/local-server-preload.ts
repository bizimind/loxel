import { setLocalServerId } from "@/api/local-server";

// The app sets this from the server before it renders (main.tsx); tests run without one.
setLocalServerId("test-server");

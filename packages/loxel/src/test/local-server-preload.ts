import { connectLocalServer } from "@/api/client";

// The app connects to its server before it renders (main.tsx); tests run without one.
connectLocalServer("test-server");

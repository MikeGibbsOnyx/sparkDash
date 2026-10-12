// Onyx: the Connect page, served by the Gateway at `/`.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../index.css";
import "../styles/shell.css";
import "./connect.css";
import { ConnectPage } from "./ConnectPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectPage />
  </StrictMode>
);

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

if (window.desktop) {
  document.body.classList.add("is-desktop");
  if (window.desktop.platform === "darwin") document.body.classList.add("is-mac");
  if (window.desktop.platform === "win32") document.body.classList.add("is-win");
}

window.addEventListener("error", (e) => console.error("[window]", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => console.error("[promise]", e.reason));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

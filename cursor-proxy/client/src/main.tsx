import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

if (window.desktop) {
  document.body.classList.add("is-desktop");
  if (window.desktop.platform === "darwin") document.body.classList.add("is-mac");
  if (window.desktop.platform === "win32") document.body.classList.add("is-win");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import React from "react";
import { createRoot } from "react-dom/client";
import { RemoteApp } from "../lib/remote-app.jsx";
import "./remote.css";
createRoot(document.getElementById("root")).render(<RemoteApp />);
// The service worker only caches the app shell (never API answers), so the app
// can be installed on the home screen.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});

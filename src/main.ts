import "./styles.css";
import { initializeApp } from "./app";

void initializeApp().catch(() => {
  const root = document.querySelector("#app");
  if (root) {
    root.replaceChildren();
    const message = document.createElement("p");
    message.className = "fatal-error";
    message.textContent = "アプリを安全に初期化できませんでした。画面を閉じて、もう一度お試しください。";
    root.append(message);
  }
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        document.documentElement.dataset.offlineReady = "true";
      })
      .catch(() => {
        document.documentElement.dataset.offlineReady = "false";
      });
  });
}

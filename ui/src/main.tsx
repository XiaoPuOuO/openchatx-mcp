import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { I18nProvider } from "./i18n"
import "./index.css"

const rootElement = document.getElementById("root")
if (!rootElement) throw new Error("Missing #root element.")

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>
)

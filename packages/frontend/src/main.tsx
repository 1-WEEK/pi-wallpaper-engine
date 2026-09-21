import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import "./tokens.css"
import "./styles.css"
import "./railShell.css"
import "./browse.css"
import "./ledger.css"
import "./focusRing.css"
import "./playerBar.css"
import "./functionalScrollbar.css"
import "./library.css"
import "./settings.css"
import "./activity.css"
import "./auth.css"

const root = document.getElementById("root")
if (!root) throw new Error("#root not found")

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import "./tokens.css"
import "./styles.css"
import "./railShell.css"
import "./browse.css"
import "./playerBar.css"

const root = document.getElementById("root")
if (!root) throw new Error("#root not found")

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

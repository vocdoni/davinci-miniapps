import { createRoot } from "react-dom/client";

import App from "./App";
import "./style.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element for React app bootstrap.");
}

createRoot(rootElement).render(<App />);

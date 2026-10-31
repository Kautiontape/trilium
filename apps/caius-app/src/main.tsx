import "@fontsource/bricolage-grotesque/500.css";
import "@fontsource/bricolage-grotesque/700.css";
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/600.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "@fontsource/atkinson-hyperlegible-mono/400.css";
import "@fontsource/atkinson-hyperlegible-mono/600.css";
import "./styles/tokens.css";

import { render } from "preact";

import { App } from "./App.js";

const root = document.getElementById("app");
if (root) {
    render(<App />, root);
}

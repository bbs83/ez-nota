declare module "*.css";

// App Bridge's <s-app-nav> is not part of @shopify/polaris-types (which only
// declares the Polaris `s-*` components), so declare it here for the React JSX
// type checker. It's a simple container for the app navigation links.
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": { children?: import("react").ReactNode };
  }
}

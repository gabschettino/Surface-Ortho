// Public configuration for the page. Nothing in this file is secret.
// The iTwin client ID comes from an iTwin Platform "Single page application" registration on
// developer.bentley.com. A client ID is public by design for SPAs. Never put access tokens here.
// The URL parameter ?clientId=... overrides itwinClientId, so another organization can use its own
// registration with a hosted copy of this page.
window.APP_CONFIG = {
  itwinClientId: "spa-ZrgZj2HLbBzhjDs28oKjCloiP",
  // Scope listed by the Reality Management and iTwins API docs. Change it here if your registration shows another.
  itwinScope: "itwin-platform",
};

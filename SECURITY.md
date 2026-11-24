# Security policy

Report a vulnerability privately through GitHub's **Report a vulnerability** action on this repository. Do not put Copilot tokens, GitHub tokens, or request and response bodies in a public issue.

## What the extension handles

- It reuses Pi's GitHub Copilot OAuth flow and stores no credential of its own; Pi stores the credential.
- It sends the Copilot token only to the HTTPS origin that the credential names, and refuses redirects on the catalog request.
- Its error messages leave out upstream response bodies, which can carry account details.

The model filter is a convenience for the model picker, not an access control: a direct model lookup or a local `models.json` override goes around it.

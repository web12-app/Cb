# deploy/

`blank.yml` is a clean copy of the Cb deployment workflow. It publishes the server
through the **Pips Tunnel** (`https://precision-pledge-fled.ngrok-free.dev`).

GitHub App tokens that lack the **Workflows** permission cannot create or update
files under `.github/workflows/` (GitHub rejects them with a 403), so the workflow
cannot be pushed from such a session. Install the updated workflow with:

```sh
cp deploy/blank.yml .github/workflows/blank.yml
```

Then commit and push it yourself, or grant the app the Workflows permission and it
can be pushed directly.

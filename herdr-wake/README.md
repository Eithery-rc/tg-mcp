# herdr-wake has moved

herdr-wake now lives with the agent board, in
[MokuTeam/herdr-agent-board/herdr-wake](https://github.com/MokuTeam/herdr-agent-board/tree/main/herdr-wake).
Install it from there:

```bash
herdr plugin install MokuTeam/herdr-agent-board/herdr-wake
herdr plugin action invoke herdr-wake.install-hooks
herdr plugin action invoke herdr-wake.start
```

The code in this folder stays for now, so installs that run from here keep working until they
switch; it gets no updates.

# Moltnet release probes

This folder owns the local wire examples used to verify a Moltnet binary before it is embedded in a container. Build and staging use the same fixtures. They connect only to loopback and use disposable state.

Release verification is independent of the project's selected agent, plugin loader, or credentials. A new harness using an existing Moltnet bridge needs no change here.

# A local-only guard replaces the Reader's hard rule

ADR 0002 made the Reader refuse anything off this machine, with no override, while the agents went wherever `OLLAMA_URL` pointed. Someone who can't run local models needs every model role to be able to use a cloud model, and anyone with sensitive notes still needs "local" to be something they can't lose by accident. So one local-only guard (`KG_LOCAL_ONLY`) now covers every model role and is on by default: going to the cloud takes two deliberate acts, naming a cloud provider and turning the guard off. With the guard on, a role that would leave the machine is refused before anything is sent, with an error naming the role and the endpoint. This reverses ADR 0002's "no override" and keeps its reason.

"Local" means loopback. The service also accepts `ollama` and `host.docker.internal`, which only mean this machine from inside a container. The Reader stays strictly loopback. An Ollama cloud model reached through the local app counts as leaving the machine, whatever its URL says. A host on the LAN counts as leaving too: that's a deliberate `KG_LOCAL_ONLY=false`.

## Considered Options

- **Off by default, opt in to protection.** Loses what ADR 0002 wanted: someone with sensitive notes would have to know to turn it on.
- **Guard only the Reader.** Keeps the Reader away from the cloud, and keeps the mismatch where a code capture can leave the machine without any setting saying so.
- **A list of local hosts (`KG_LOCAL_HOSTS`).** ADR 0002 rejected an override for a LAN Ollama. A list would bring it back in a form that reads as still local.

## Consequences

- A setup that sends model calls to hosted Ollama, as issue #29 allowed, stops at startup until `KG_LOCAL_ONLY=false` is added.
- With the guard off, the Reader follows the default chat model like any other chat role, unless `KG_READER_MODEL` pins it to a local one.
- Memos are unaffected: the session's own agent writes them, so "100% local" keeps that exception.

# Wordcraft agent-runtime

Backend Rust (axum) del agente integrado de Wordcraft. Usa el **CLI oficial Claude Code** ya autenticado con tu cuenta Claude (`claude auth login`). No usa API key, no lee ni guarda tokens OAuth.

## Arquitectura

```
UI --/api/agent (proxy dev)--> axum 127.0.0.1:3210
                                  └─ spawn: claude -p --output-format stream-json ...
                                        └─ MCP stdio: <este binario> --mcp --snapshot <tmp>/snapshot.txt
                                              (servidor rmcp, tool wordcraft_get_document, solo lectura)
```

Por cada request se crea un directorio temporal privado con `snapshot.txt` (texto del documento) y `mcp.json`; se borra al terminar. El CLI se ejecuta con ese directorio como cwd (no carga CLAUDE.md/.mcp.json del proyecto).

Flags usados (docs oficiales de Claude Code CLI): `-p`, `--output-format stream-json --verbose`, `--strict-mcp-config --mcp-config`, `--tools ""` (sin herramientas built-in), `--allowedTools mcp__wordcraft__wordcraft_get_document`, `--permission-mode dontAsk`, `--no-session-persistence`, `--disable-slash-commands`, `--settings '{"disableAllHooks":true}'` (evita hooks de usuario; `disableAllHooks` está en la referencia de settings), `--max-turns 6`, `--system-prompt`, y `--model` solo si defines `CLAUDE_AGENT_MODEL`. **No** se usa `--bare` (desactiva el login OAuth). El prompt se envía por stdin. Se eliminan `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` y `CLAUDE_CODE_OAUTH_TOKEN` del entorno del hijo para que use la cuenta con login.

## Requisitos y ejecución (Windows / PowerShell)

1. Instalar Claude Code con el instalador nativo (PowerShell: `irm https://claude.ai/install.ps1 | iex`; no el paquete npm, cuyo `claude.cmd` no se encuentra desde Rust) y tener cuenta Claude (Pro/Max/Team/Enterprise).
2. Login (una vez): `claude auth login` (o `POST /api/agent/login`).
3. Ejecutar:

```powershell
cd agent-runtime
cargo run
```

Variables opcionales: `CLAUDE_CLI_PATH` (ruta a claude.exe; en Windows se busca también en `%USERPROFILE%\.local\bin`), `WORDCRAFT_AGENT_ALLOWED_ORIGINS` (orígenes `Origin` permitidos, separados por comas; por defecto `http://localhost:3000,http://127.0.0.1:3000`; los `Host`/`Origin` ajenos reciben 403), `CLAUDE_AGENT_MODEL` (alias o nombre completo; por defecto el del CLI).

```powershell
cargo fmt; cargo check; cargo test
cargo run -- --mcp --snapshot C:\ruta\snapshot.txt   # servidor MCP stdio suelto
```

## API (bind 127.0.0.1:3210, sin CORS; usar el proxy de dev)

- `GET /api/agent/health` (usa `claude auth status --json`) -> `{ready, provider:"claude-code", model, cliInstalled, loggedIn, loginRequired, authMethod?, subscriptionType?}`. `ready` = CLI instalado, `loggedIn` y `authMethod == "claude.ai"` (cuenta Claude). Otros métodos (`api_key`, `api_key_helper`, `third_party`, `oauth_token`) no cuentan como ready; en ese caso `loginRequired:true`. Sin email ni datos de organización.
- `POST /api/agent/login` -> `{started, alreadyLoggedIn, running, url?, message}`. Lanza `claude auth login --claudeai` sin bloquear (stdin del hijo es nulo; el CLI abre el navegador por su cuenta y, si imprime una URL, se devuelve en `url`). Si no aparece navegador o hace falta pegar un código manualmente, ejecutar `claude auth login` en una terminal propia (fallback). Si ya hay un login en curso: `started:true, running:true`; las llamadas simultáneas se serializan (solo un proceso). Si ya hay sesión: `started:true, alreadyLoggedIn:true`. Timeout del flujo: 10 min. Luego consultar health.
- `POST /api/agent/chat`
  - Request: `{messages:[{role:"user"|"assistant",content:string}], document:{text:string}}`
  - Response: `{reply:string, toolCalls:[{name:string}], model:string}` (`model` lo informa el CLI).
  - Errores `{error}`: 400 validación, 413 body > 1 MiB, 401 sin login, 429 >2 concurrentes, 502 fallo del CLI, 503 CLI no instalado, 504 timeout (180 s).
  - Validación: máx 50 mensajes, 20 000 chars/mensaje, documento 200 000 chars, primer y último mensaje `user`.

## Tests

`cargo test`: handshake/list/call MCP en proceso (duplex) y por stdio contra el binario real con snapshot en archivo; argumentos del CLI; parseo stream-json/errores; contrato HTTP y validación con un proveedor falso (sin red ni CLI). Verificado además a mano con el CLI real y sesión claude.ai.

## Estado y límites

- MVP **solo lectura**: el agente puede leer el documento y responder; **no edita** el documento.
- Snapshot: se envía el texto con cada request; no hay sincronización ni streaming a la UI.
- Cada request lanza un proceso `claude` (latencia de segundos) y consume el uso de tu plan.
- `--permission-mode dontAsk` + `--tools ""` limitan al agente a esa única tool MCP.
- Cancelar en la UI solo cancela la espera del navegador/fetch; el backend no implementa cancelación, así que el proceso `claude` puede seguir hasta terminar o hasta el timeout de 180 s (y seguir consumiendo uso del plan).
- Autenticación: este runtime solo invoca el CLI oficial de Claude Code instalado localmente, con su flujo de login oficial. No implementa OAuth propio, no lee ni almacena tokens y no maneja cuentas de otros usuarios. No se interpretan aquí los términos de Anthropic; revisa la documentación legal de Claude Code antes de usarlo fuera de tu propio equipo.

# Repository Guidelines

## Backward Compatibility

- Treat backward compatibility as a release requirement. Existing recordings, persisted metadata, configuration, CLI behavior, IPC/API payloads, and integrations must continue to work unless an explicitly approved breaking change includes a migration and rollout plan.
- Prefer additive schema and API changes with tolerant readers. Do not remove or rename existing fields or change their meaning without versioning, migration coverage, and a verified fallback path.
- For cross-cutting changes, audit every consumer along with tests, scripts, and documentation, and add regression coverage proving that existing data and legacy behavior remain usable.

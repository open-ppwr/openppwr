# API versioning and compatibility

- Public HTTP contracts use a major path prefix such as `/v1`.
- Backward-compatible fields may be added within a major version; clients must ignore unknown response fields.
- Removing or changing meaning/type requires a new major API version.
- Stable error, role, outcome and workflow codes are never localized.
- OpenAPI and JSON Schema artifacts will be release-controlled; the current route contract remains beta.
- Security fixes may narrow previously unsafe behavior without a deprecation period.
- Intended deprecations receive documentation, replacement guidance and at least one supported minor release where practicable.
- Events and connector contracts are not public-stable until a real second consumer justifies them.

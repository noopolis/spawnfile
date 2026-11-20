# Runtime image

This adapter owns its Docker build context and versioned image metadata.
`build.json` describes the build for the repository image catalog.

Keep generated organization data and credentials out of this context.
The final stage is a copy source for the packaged runtime install tree.

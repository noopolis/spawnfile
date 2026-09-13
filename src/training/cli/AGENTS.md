# Command Interface

Owns explicit local commands, configuration selection and human diagnostics.

- Keep commands thin; experiment, evaluation and optimization behavior belongs
  in their owning modules, not duplicated argument handlers.
- No CLI command exists yet. Add documented clean-state examples with real tests.
- Surface unsupported capabilities, missing credentials, incomplete observations
  and real terminal outcomes plainly. Exit zero requires the intended artifact.
- Never start deployment, publication or paid API fallback implicitly.
- Group commands by cohesive feature as the surface grows; retain named entry
  points and adjacent parsing/behavior tests.
- Test invalid inputs, cancel/error exit behavior and positive output artifacts,
  not just whether a child process launched.

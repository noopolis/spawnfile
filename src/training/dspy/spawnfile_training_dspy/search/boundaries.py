"""Mechanical text constraints; never interpret prose or trust proposer claims."""
import json
import re

from ..protocol import BridgeError


def compile_boundaries(declarations: list[str], seed: dict[str, str]) -> list[tuple]:
    rules = []
    for declaration in declarations:
        match = re.fullmatch(r'(preserve|require-text|forbid-text|max-bytes) (\[.*\])', declaration, re.DOTALL)
        try:
            args = json.loads(match[2]) if match else None
        except ValueError:
            args = None
        if (not match or not isinstance(args, list)
                or len(args) != (1 if match[1] == 'preserve' else 2)
                or any(not isinstance(arg, str) or not arg.strip() for arg in args)
                or args[0] not in seed
                or (match[1] == 'max-bytes' and not re.fullmatch(r'[1-9][0-9]{0,8}', args[1]))):
            raise BridgeError('unsupported_boundaries', 'Unsupported hard boundary: expected '
                              'preserve [component], require-text [component, text], '
                              'forbid-text [component, text] or max-bytes [component, "<bytes>"] '
                              'with JSON string arguments and a known component')
        rules.append((match[1], args[0], seed[args[0]] if match[1] == 'preserve' else args[1]))
    if boundary_violation(rules, seed):
        raise BridgeError('boundary_violation', 'Seed violates a declared hard boundary')
    return rules


def boundary_violation(rules: list[tuple], components: dict[str, str]) -> bool:
    for kind, component, text in rules:
        value = components.get(component)
        if not isinstance(value, str):
            return True
        if ((kind == 'preserve' and value != text)
                or (kind == 'require-text' and text not in value)
                or (kind == 'forbid-text' and text in value)
                or (kind == 'max-bytes' and len(value.encode('utf-8')) > int(text))):
            return True
    return False

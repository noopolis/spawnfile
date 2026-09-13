import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rule, SourceCode } from 'eslint';
import { preProcessFile } from 'typescript';
import { canonicalPath, importTarget, inside, owner, pathParts } from './paths.js';

const neutralOwners = new Set(['contracts', 'cases', 'evaluation', 'capture', 'candidates', 'storage']);
const runtimeOwners = new Set(['adapters', 'inference', 'experiments', 'optimization']);
const siblingPackages = /^(?:spawnfile|simfile|moltnet|@noopolis\/(?:daimon|mneme|stele))(?:\/|$)/;

export const moduleBoundaries: Rule.RuleModule = {
  meta: { type: 'problem', schema: [], messages: {
    escape: 'Imports cannot escape this repository; consume a declared public package instead.',
    seam: 'Cross-module imports must use the target public index, not an implementation file.',
    neutral: 'Neutral core modules cannot import runtime integrations or experiment lifecycle.',
    runtime: 'Ecosystem integrations belong to their adapter and consume public package interfaces only.',
    dynamic: 'Computed imports cannot prove a module boundary; use a literal or a constant literal binding.',
    alias: 'Package subpath aliases are not public module seams; use an explicit relative index.',
  } },
  create(context) {
    function check(node: Parameters<SourceCode['getScope']>[0], specifier: unknown): void {
      if (typeof specifier !== 'string') { context.report({ node, messageId: 'dynamic' }); return; }
      const filename = canonicalPath(context.physicalFilename);
      const root = canonicalPath(context.cwd);
      const from = pathParts(root, filename);
      if (specifier.startsWith('#')) { context.report({ node, messageId: 'alias' }); return; }
      if (siblingPackages.test(specifier)) {
        const daimonPublic = from[0] === 'src' && from[1] === 'adapters' && (
          from[2] === 'daimon' && specifier === '@noopolis/daimon/pi' ||
          from[2] === 'daimon-native' && specifier === '@noopolis/daimon/runtime');
        if (!daimonPublic) {
          context.report({ node, messageId: 'runtime' });
        }
        return;
      }
      let resolvedSpecifier = specifier;
      if (specifier.startsWith('file:')) {
        try { resolvedSpecifier = fileURLToPath(specifier); }
        catch { context.report({ node, messageId: 'escape' }); return; }
      }
      if (!resolvedSpecifier.startsWith('.') && !path.isAbsolute(resolvedSpecifier)) return;
      const target = importTarget(filename, resolvedSpecifier);
      if (!inside(root, target)) { context.report({ node, messageId: 'escape' }); return; }
      const to = pathParts(root, target);
      if (from[0] === 'src' && neutralOwners.has(from[1] ?? '') && to[0] === 'src' &&
        (runtimeOwners.has(to[1] ?? '') || owner(to) === 'src')) {
        context.report({ node, messageId: 'neutral' }); return;
      }
      // Each contracts/*.ts file is an intentional runtime-neutral public type seam.
      if (to[0] === 'src' && to[1] === 'contracts' && to.length === 3) return;
      const sourceOwner = owner(from);
      const targetOwner = owner(to);
      if (targetOwner === undefined) return;
      const sourceDirectory = path.dirname(filename);
      const targetDirectory = path.dirname(target);
      const sameTree = inside(sourceDirectory, targetDirectory) || inside(targetDirectory, sourceDirectory);
      if ((sourceOwner !== targetOwner || !sameTree) && !/^index\.[cm]?[jt]s$/.test(path.basename(target))) {
        context.report({ node, messageId: 'seam' });
      }
    }
    function value(node: Parameters<SourceCode['getScope']>[0] | undefined): unknown {
      if (node?.type === 'Literal') return node.value;
      if (node?.type !== 'Identifier') return undefined;
      let scope = context.sourceCode.getScope(node);
      for (;;) {
        const variable = scope.set.get(node.name);
        if (variable !== undefined) {
          const definition = variable.defs[0];
          return definition?.type === 'Variable' && definition.parent.kind === 'const' && definition.node.init?.type === 'Literal'
            ? definition.node.init.value : undefined;
        }
        if (scope.upper === null) return undefined;
        scope = scope.upper;
      }
    }
    return {
      Program(node) {
        for (const reference of preProcessFile(context.sourceCode.text, false, false).referencedFiles) {
          check(node, path.resolve(path.dirname(canonicalPath(context.physicalFilename)), reference.fileName));
        }
      },
      TSImportEqualsDeclaration(node: Rule.Node) {
        const reference = (node as unknown as { moduleReference: { type: string; expression?: { value: unknown } } }).moduleReference;
        if (reference.type === 'TSExternalModuleReference') check(node, reference.expression?.value);
      },
      ImportDeclaration(node) { check(node, node.source.value); },
      ExportNamedDeclaration(node) { if (node.source != null) check(node, node.source.value); },
      ExportAllDeclaration(node) { check(node, node.source.value); },
      ImportExpression(node) { check(node, value(node.source)); },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          check(node, value(node.arguments[0]));
        }
      },
    };
  },
};

// Minimal, structurally-typed slice of an OpenAPI 3.x document -- just enough
// to walk security schemes and per-operation security requirements. Deliberately
// not the full hey-api/openapi-ts spec type: this module only ever reads the
// two fields that matter for a security diff.

export type SecurityRequirement = Record<string, string[]>;
export type SecurityRequirementSet = SecurityRequirement[];

export interface SecuritySchemeObject {
  type?: string;
  in?: string;
  name?: string;
}

export interface OperationObject {
  operationId?: string;
  security?: SecurityRequirementSet;
}

export interface OpenApiSpecLike {
  paths?: Record<string, Record<string, OperationObject>>;
  components?: { securitySchemes?: Record<string, SecuritySchemeObject> };
}

export interface SchemeMoved {
  scheme: string;
  oldName: string | undefined;
  newName: string | undefined;
}

export interface OperationSecurityChange {
  operationId: string;
  path: string;
  method: string;
  oldRequirement: string;
  newRequirement: string;
  /** The dangerous direction: the operation required a credential and now does not. */
  droppedCredential: boolean;
}

export interface SecurityDiff {
  schemesAdded: string[];
  schemesRemoved: string[];
  schemesMoved: SchemeMoved[];
  operationChanges: OperationSecurityChange[];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

interface CollectedOperation {
  path: string;
  method: string;
  security: SecurityRequirementSet;
}

function collectOperations(spec: OpenApiSpecLike): Map<string, CollectedOperation> {
  const operations = new Map<string, CollectedOperation>();
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation.operationId !== 'string') continue;
      operations.set(operation.operationId, {
        path,
        method,
        security: operation.security ?? [],
      });
    }
  }
  return operations;
}

/** Canonical string for a requirement set: order-independent, scope-order-independent. */
function canonicalizeRequirementSet(security: SecurityRequirementSet): string {
  const alternatives = security
    .map((requirement) => {
      const entries = Object.entries(requirement)
        .map(([scheme, scopes]) => `${scheme}:[${[...scopes].sort().join(',')}]`)
        .sort();
      return `{${entries.join(';')}}`;
    })
    .sort();
  return alternatives.join('|');
}

function describeRequirementSet(security: SecurityRequirementSet): string {
  if (security.length === 0) return '(none)';
  return security
    .map((requirement) => Object.keys(requirement).sort().join('+') || '(empty)')
    .join(' OR ');
}

function requiresCredential(security: SecurityRequirementSet): boolean {
  return security.some((requirement) => Object.keys(requirement).length > 0);
}

export function computeSecurityDiff(
  oldSpec: OpenApiSpecLike,
  newSpec: OpenApiSpecLike,
): SecurityDiff {
  const oldSchemes = oldSpec.components?.securitySchemes ?? {};
  const newSchemes = newSpec.components?.securitySchemes ?? {};

  const schemesAdded = Object.keys(newSchemes)
    .filter((name) => !(name in oldSchemes))
    .sort();
  const schemesRemoved = Object.keys(oldSchemes)
    .filter((name) => !(name in newSchemes))
    .sort();
  const schemesMoved: SchemeMoved[] = Object.keys(oldSchemes)
    .filter((name) => name in newSchemes)
    .filter((name) => oldSchemes[name]?.name !== newSchemes[name]?.name)
    .map((scheme) => ({
      scheme,
      oldName: oldSchemes[scheme]?.name,
      newName: newSchemes[scheme]?.name,
    }))
    .sort((a, b) => a.scheme.localeCompare(b.scheme));

  const oldOps = collectOperations(oldSpec);
  const newOps = collectOperations(newSpec);

  const operationChanges: OperationSecurityChange[] = [];
  for (const [operationId, oldOp] of oldOps) {
    const newOp = newOps.get(operationId);
    // An operation only present on one side is an addition/removal, not a
    // security-requirement drift on a shared operation -- out of scope here.
    if (!newOp) continue;
    if (canonicalizeRequirementSet(oldOp.security) === canonicalizeRequirementSet(newOp.security)) {
      continue;
    }
    operationChanges.push({
      operationId,
      path: newOp.path,
      method: newOp.method.toUpperCase(),
      oldRequirement: describeRequirementSet(oldOp.security),
      newRequirement: describeRequirementSet(newOp.security),
      droppedCredential: requiresCredential(oldOp.security) && !requiresCredential(newOp.security),
    });
  }
  operationChanges.sort((a, b) => a.operationId.localeCompare(b.operationId));

  return { schemesAdded, schemesRemoved, schemesMoved, operationChanges };
}

export function hasChanges(diff: SecurityDiff): boolean {
  return (
    diff.schemesAdded.length > 0 ||
    diff.schemesRemoved.length > 0 ||
    diff.schemesMoved.length > 0 ||
    diff.operationChanges.length > 0
  );
}

export function formatSecurityDiff(diff: SecurityDiff): string {
  const lines: string[] = [];
  if (diff.schemesAdded.length > 0) {
    lines.push(`Schemes added: ${diff.schemesAdded.join(', ')}`);
  }
  if (diff.schemesRemoved.length > 0) {
    lines.push(`Schemes removed: ${diff.schemesRemoved.join(', ')}`);
  }
  for (const moved of diff.schemesMoved) {
    lines.push(`Scheme header moved: ${moved.scheme} "${moved.oldName}" -> "${moved.newName}"`);
  }
  for (const change of diff.operationChanges) {
    const flag = change.droppedCredential ? ' [DANGEROUS: credential requirement dropped]' : '';
    lines.push(
      `${change.operationId} (${change.method} ${change.path}): ` +
        `${change.oldRequirement} -> ${change.newRequirement}${flag}`,
    );
  }
  return lines.length > 0 ? lines.join('\n') : 'No security changes.';
}

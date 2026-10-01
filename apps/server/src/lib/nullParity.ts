import { Prisma } from '@prisma/client';

/**
 * Null parity between PostgreSQL and MongoDB for Prisma writes.
 *
 * In PostgreSQL every column exists on every row, so an optional field that was not
 * provided on create is stored as NULL, and `where: { deletedAt: null }` matches it.
 * In MongoDB, Prisma omits such a field from the document entirely, and Prisma's
 * `field: null` filter matches only fields that are explicitly null, not missing ones.
 * Left alone, every query in this codebase that filters on `deletedAt: null`,
 * `expiresAt: null`, `scheduledFor: null` or `folderId: null` would silently return
 * nothing for records created without those fields.
 *
 * The functions below rewrite create payloads (top-level and nested) so that every
 * optional scalar the caller did not set is written as an explicit `null`. Stored
 * documents therefore have exactly the shape PostgreSQL rows had, and every existing
 * query keeps its original meaning without modification.
 *
 * Model metadata is read from the generated client (`Prisma.dmmf`), so this stays
 * correct automatically when the schema changes.
 */

interface RelationMeta {
  target: string;
  relationName: string;
}

interface ModelMeta {
  /** Optional, non-list scalar and enum fields. */
  optionalScalars: string[];
  /** Scalar fields that are foreign keys of a relation declared on this model. */
  foreignKeys: Set<string>;
  /** Relation fields whose foreign keys live on this model (to-one, owning side). */
  owningRelations: Set<string>;
  /** Every relation field on this model, keyed by field name. */
  relations: Map<string, RelationMeta>;
  /** Every field name on this model (used to tell a nested `data` wrapper from a field). */
  fieldNames: Set<string>;
  /** Relation fields grouped by relation name, with the foreign keys each one declares. */
  relationSides: Map<string, { field: string; foreignKeys: readonly string[] }[]>;
}

interface DmmfField {
  name: string;
  kind: string;
  isList: boolean;
  isRequired: boolean;
  type: string;
  relationName?: string | null;
  relationFromFields?: readonly string[] | null;
}

interface DmmfModel {
  name: string;
  fields: readonly DmmfField[];
}

type PlainObject = Record<string, unknown>;

const EMPTY_SET: ReadonlySet<string> = new Set();

function buildMetadata(models: readonly DmmfModel[]): Map<string, ModelMeta> {
  const result = new Map<string, ModelMeta>();
  for (const model of models) {
    const meta: ModelMeta = {
      optionalScalars: [],
      foreignKeys: new Set(),
      owningRelations: new Set(),
      relations: new Map(),
      fieldNames: new Set(),
      relationSides: new Map(),
    };
    for (const field of model.fields) {
      meta.fieldNames.add(field.name);
      if (field.kind === 'object') {
        meta.relations.set(field.name, { target: field.type, relationName: field.relationName ?? '' });
        const fks = field.relationFromFields ?? [];
        const sides = meta.relationSides.get(field.relationName ?? '') ?? [];
        sides.push({ field: field.name, foreignKeys: fks });
        meta.relationSides.set(field.relationName ?? '', sides);
        if (fks.length > 0) {
          meta.owningRelations.add(field.name);
          for (const fk of fks) meta.foreignKeys.add(fk);
        }
      } else if ((field.kind === 'scalar' || field.kind === 'enum') && !field.isRequired && !field.isList) {
        meta.optionalScalars.push(field.name);
      }
    }
    result.set(model.name, meta);
  }
  return result;
}

let metadata: Map<string, ModelMeta> | null = null;

function getMetadata(): Map<string, ModelMeta> {
  if (!metadata) {
    metadata = buildMetadata(Prisma.dmmf.datamodel.models as unknown as readonly DmmfModel[]);
  }
  return metadata;
}

/** Test hook: lets unit tests supply their own model metadata. */
export function setModelMetadataForTesting(models: readonly DmmfModel[]): void {
  metadata = buildMetadata(models);
}

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function mapOneOrMany(value: unknown, fn: (item: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(fn) : fn(value);
}

/**
 * Foreign keys on the child model that the parent supplies implicitly during a nested
 * create (for example `conversationId` when creating members inside a conversation).
 * Prisma rejects those keys in nested input, so they must never be filled.
 */
function backReferenceKeys(parentModel: string, parentField: string, relation: RelationMeta): ReadonlySet<string> {
  const child = getMetadata().get(relation.target);
  if (!child) return EMPTY_SET;
  const parent = getMetadata().get(parentModel);
  // If the parent owns the foreign key, the child has nothing pointing back.
  if (parent?.owningRelations.has(parentField)) return EMPTY_SET;

  const keys = new Set<string>();
  for (const side of child.relationSides.get(relation.relationName) ?? []) {
    // In a self-relation both sides live on the same model; skip the field we came from.
    if (relation.target === parentModel && side.field === parentField) continue;
    for (const fk of side.foreignKeys) keys.add(fk);
  }
  return keys;
}

function transformNestedWrites(model: string, field: string, relation: RelationMeta, value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const excluded = backReferenceKeys(model, field, relation);
  const target = relation.target;
  const out: PlainObject = { ...value };

  if (out.create !== undefined) {
    out.create = mapOneOrMany(out.create, (item) => fillCreateData(target, item, excluded));
  }
  if (isPlainObject(out.createMany) && out.createMany.data !== undefined) {
    out.createMany = {
      ...out.createMany,
      data: mapOneOrMany(out.createMany.data, (item) => fillCreateData(target, item, excluded)),
    };
  }
  if (out.connectOrCreate !== undefined) {
    out.connectOrCreate = mapOneOrMany(out.connectOrCreate, (item) =>
      isPlainObject(item) ? { ...item, create: fillCreateData(target, item.create, excluded) } : item,
    );
  }
  if (out.upsert !== undefined) {
    out.upsert = mapOneOrMany(out.upsert, (item) =>
      isPlainObject(item)
        ? { ...item, create: fillCreateData(target, item.create, excluded), update: fillUpdateData(target, item.update) }
        : item,
    );
  }
  if (out.update !== undefined) {
    out.update = mapOneOrMany(out.update, (item) => fillUpdateWrapper(target, item));
  }
  return out;
}

/** A nested `update` is either the data itself or a `{ where?, data }` wrapper. */
function fillUpdateWrapper(model: string, item: unknown): unknown {
  if (!isPlainObject(item)) return item;
  const meta = getMetadata().get(model);
  if (meta && !meta.fieldNames.has('data') && isPlainObject(item.data)) {
    return { ...item, data: fillUpdateData(model, item.data) };
  }
  return fillUpdateData(model, item);
}

/**
 * Returns a copy of a create payload in which every optional scalar the caller left
 * unset (absent or `undefined`) is set to an explicit `null`, recursing into nested
 * relation writes.
 */
export function fillCreateData(model: string, data: unknown, excluded: ReadonlySet<string> = EMPTY_SET): unknown {
  if (!isPlainObject(data)) return data;
  const meta = getMetadata().get(model);
  if (!meta) return data;

  const out: PlainObject = { ...data };

  // Prisma accepts either "checked" input (relations via `connect`) or "unchecked"
  // input (raw foreign-key scalars), never a mix. Foreign-key scalars may only be
  // filled when the payload is not already using the checked form.
  const usesCheckedInput = [...meta.owningRelations].some((name) => out[name] !== undefined);

  for (const name of meta.optionalScalars) {
    if (out[name] !== undefined) continue;
    if (excluded.has(name)) continue;
    if (usesCheckedInput && meta.foreignKeys.has(name)) continue;
    out[name] = null;
  }

  for (const [name, relation] of meta.relations) {
    if (out[name] === undefined || out[name] === null) continue;
    out[name] = transformNestedWrites(model, name, relation, out[name]);
  }
  return out;
}

/** Update payloads keep their own null semantics; only nested creates are rewritten. */
export function fillUpdateData(model: string, data: unknown): unknown {
  if (!isPlainObject(data)) return data;
  const meta = getMetadata().get(model);
  if (!meta) return data;

  let out: PlainObject | null = null;
  for (const [name, relation] of meta.relations) {
    if (data[name] === undefined || data[name] === null) continue;
    out ??= { ...data };
    out[name] = transformNestedWrites(model, name, relation, data[name]);
  }
  return out ?? data;
}

/** Prisma client extension applying null parity to every model. */
export const nullParityExtension = Prisma.defineExtension({
  name: 'mongo-null-parity',
  query: {
    $allModels: {
      async create({ model, args, query }) {
        const next = args as { data: unknown };
        next.data = fillCreateData(model, next.data);
        return query(args);
      },
      async createMany({ model, args, query }) {
        const next = args as { data: unknown };
        next.data = mapOneOrMany(next.data, (item) => fillCreateData(model, item));
        return query(args);
      },
      async upsert({ model, args, query }) {
        const next = args as { create: unknown; update: unknown };
        next.create = fillCreateData(model, next.create);
        next.update = fillUpdateData(model, next.update);
        return query(args);
      },
      async update({ model, args, query }) {
        const next = args as { data: unknown };
        next.data = fillUpdateData(model, next.data);
        return query(args);
      },
    },
  },
});

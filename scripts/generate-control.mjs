import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { format, resolveConfig } from "prettier";

const source = "packages/protocol/control.schema.json";
const schema = JSON.parse(readFileSync(source, "utf8"));
const variants = schema.properties.operation.oneOf;
const heading = `// Generated from ${source} by scripts/generate-control.mjs.\n`;

function primitive(definition, language) {
  switch (definition.type) {
    case "string":
      return language === "rust" ? "String" : "string";
    case "boolean":
      return language === "rust" ? "bool" : "boolean";
    case "integer":
      return language === "rust" ? definition["x-rust-type"] : "number";
    case "array":
      return language === "rust"
        ? `Vec<${primitive(definition.items, language)}>`
        : `${primitive(definition.items, language)}[]`;
    default:
      if (
        Array.isArray(definition.type) &&
        definition.type.join(",") === "string,null"
      ) {
        return language === "rust" ? "Option<String>" : "string | null";
      }
      throw new Error(`Unsupported schema type ${definition.type}`);
  }
}

function fields(variant) {
  return Object.entries(variant.properties)
    .filter(([name]) => name !== "type")
    .map(([name, definition]) => ({
      name,
      definition,
      optional: !variant.required.includes(name),
    }));
}

function rustVariant(variant) {
  const tag = variant.properties.type.const;
  const name = tag
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const members = fields(variant).map((field) => {
    const snake = field.name.replace(
      /[A-Z]/g,
      (letter) => "_" + letter.toLowerCase(),
    );
    const tag =
      snake !== field.name ? `#[serde(rename = "${field.name}")] ` : "";
    const type = primitive(field.definition, "rust");
    return `${tag}${snake}: ${field.optional && !type.startsWith("Option<") ? `Option<${type}>` : type}`;
  });
  return members.length ? `${name} { ${members.join(", ")} }` : name;
}

function typescriptVariant(variant) {
  const members = fields(variant).map(
    (field) =>
      `${field.name}${field.optional ? "?" : ""}: ${primitive(field.definition, "typescript")}`,
  );
  return `{ type: "${variant.properties.type.const}"; ${members.join("; ")} }`;
}

const rust = `${heading}
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub id: ${primitive(schema.properties.id, "rust")},
    pub operation: Operation,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case", tag = "type")]
pub(crate) enum Operation {
    ${variants.map(rustVariant).join(",\n")},
}
`;
const typescript = `${heading}export type Operation = ${variants.map(typescriptVariant).join(" | ")};\n`;
const tsPath = "apps/cli/src/protocol/operation.ts";
const rustPath = "crates/ssux-agent/src/operation.rs";
const generated = {
  [tsPath]: await format(typescript, {
    ...(await resolveConfig(tsPath)),
    filepath: tsPath,
  }),
  [rustPath]: execFileSync(
    "rustfmt",
    ["--edition", "2024", "--emit", "stdout"],
    { input: rust, encoding: "utf8" },
  ),
};

for (const [path, body] of Object.entries(generated)) {
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== body)
      throw new Error(
        `Regenerate ${path} with node scripts/generate-control.mjs`,
      );
  } else writeFileSync(path, body);
}

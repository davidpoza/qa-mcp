import { promises as fs } from "node:fs";
import path from "node:path";
import { LoadedContext, RfEntry } from "../types";
import { extractOrBuildRfEntries } from "../rfcu";

function javaClassName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9]+/g, " ");
  const pascal = cleaned
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
  return pascal.length > 0 ? pascal : "GeneratedApi";
}

function javaMethodName(value: string): string {
  const cls = javaClassName(value);
  return cls.charAt(0).toLowerCase() + cls.slice(1);
}

function openApiSnippet(content: string): string {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(0, 5).join(" | ");
}

function buildJavaTest(entry: RfEntry, openApiContext: string): string {
  const className = `${javaClassName(entry.name)}ApiTest`;
  const primaryMethodPath = entry.methodPath.split(/\s*;\s*/)[0] ?? entry.methodPath;
  const methods = entry.cases
    .map((cu, index) => {
      const methodName = `${javaMethodName(cu.name)}_${index + 1}`;
      return [
        "    @Test",
        `    void ${methodName}() {`,
        "        // TODO: completar baseUri/basePath, auth y payload según entorno",
        `        given()`,
        `            .log().all()`,
        "        .when()",
        `            .request("${primaryMethodPath}")`,
        "        .then()",
        "            .log().all();",
        "    }",
      ].join("\n");
    })
    .join("\n\n");

  return [
    `// Contexto OpenAPI: ${openApiContext}`,
    "import io.restassured.RestAssured;",
    "import org.junit.jupiter.api.Test;",
    "import static io.restassured.RestAssured.given;",
    "",
    `public class ${className} {`,
    "",
    "    static {",
    "        RestAssured.enableLoggingOfRequestAndResponseIfValidationFails();",
    "    }",
    "",
    methods,
    "}",
    "",
  ].join("\n");
}

export async function generateRestTests(context: LoadedContext): Promise<{ files: string[]; rfCount: number }> {
  const outputRoot = path.resolve(path.dirname(context.configPath), context.config.restTests);
  await fs.mkdir(outputRoot, { recursive: true });

  const entries = extractOrBuildRfEntries(context);
  const files: string[] = [];
  for (const entry of entries) {
    const className = `${javaClassName(entry.name)}ApiTest.java`;
    const fullPath = path.join(outputRoot, className);
    await fs.writeFile(fullPath, buildJavaTest(entry, openApiSnippet(context.openApiContent)), "utf8");
    files.push(fullPath);
  }
  return { files, rfCount: entries.length };
}

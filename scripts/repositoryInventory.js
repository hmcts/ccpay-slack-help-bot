const path = require("path");
const catalog = require("../config/repository-catalog.json");
const rules = require("../config/repository-inventory-rules.json");

const VERSION_FILE_NAMES = new Set([
  ".nvmrc",
  ".node-version",
  ".java-version",
  ".tool-versions",
  ".terraform-version",
  "package.json",
  "pom.xml",
  ".yarnrc.yml",
  "gradle-wrapper.properties",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "libs.versions.toml",
]);

function isRepositoryMetadataPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  const basename = path.posix.basename(normalized).toLowerCase();
  return VERSION_FILE_NAMES.has(basename) ||
    basename.startsWith("dockerfile") ||
    normalized.toLowerCase().endsWith(".tf") ||
    normalized.toLowerCase().endsWith(".toml") ||
    normalized.toLowerCase().endsWith(".gradle") ||
    normalized.toLowerCase().endsWith(".gradle.kts") ||
    (normalized.startsWith(".github/workflows/") && /\.(yml|yaml)$/i.test(normalized)) ||
    /(^|\/)\.yarn\/releases\/yarn-[\d.]+\.c?js$/i.test(normalized);
}

function lineAt(content, offset) {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function escapeRegex(value) {
  return value.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

function makeFileUrl(repository, branch, relativePath, line) {
  const encodedBranch = String(branch || "HEAD")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const encodedPath = relativePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return "https://github.com/" + repository + "/blob/" + encodedBranch + "/" + encodedPath + "#L" + line;
}

function addObservation(observations, repository, branch, file, technology, role, value, offset) {
  const cleanValue = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!cleanValue) return;
  const line = lineAt(file.content, offset);
  const url = makeFileUrl(repository, branch, file.relativePath, line);
  const observation = { technology, role, value: cleanValue, file: file.relativePath, line, url };
  const duplicate = observations.some((item) =>
    item.technology === observation.technology &&
    item.role === observation.role &&
    item.value === observation.value &&
    item.file === observation.file &&
    item.line === observation.line
  );
  if (!duplicate) observations.push(observation);
}

function addLineObservations(observations, repository, branch, file, regex, technology, role, captureIndex = 1) {
  regex.lastIndex = 0;
  for (const match of file.content.matchAll(regex)) {
    addObservation(
      observations,
      repository,
      branch,
      file,
      technology,
      role,
      match[captureIndex],
      match.index,
    );
  }
}

function collectVersionObservations(repository, branch, files) {
  const observations = [];
  for (const file of files) {
    const relativePath = file.relativePath.split(path.sep).join("/");
    const basename = path.posix.basename(relativePath).toLowerCase();

    if (basename === ".nvmrc" || basename === ".node-version") {
      addLineObservations(
        observations, repository, branch, file,
        /^\s*(v?\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?)\s*$/gm,
        "Node.js", "local runtime declaration",
      );
    }
    if (basename === ".java-version") {
      addLineObservations(
        observations, repository, branch, file,
        /^\s*(\d+(?:\.\d+)?(?:[-+][\w.-]+)?)\s*$/gm,
        "Java", "local runtime declaration",
      );
    }
    if (basename === ".tool-versions") {
      addLineObservations(
        observations, repository, branch, file,
        /^\s*nodejs\s+(\S+)/gm,
        "Node.js", "tool version declaration",
      );
      addLineObservations(
        observations, repository, branch, file,
        /^\s*java\s+(\S+)/gm,
        "Java", "tool version declaration",
      );
      addLineObservations(
        observations, repository, branch, file,
        /^\s*terraform\s+(\S+)/gm,
        "Terraform", "tool version declaration",
      );
    }
    if (basename === ".terraform-version") {
      addLineObservations(
        observations, repository, branch, file,
        /^\s*(\d+(?:\.\d+){1,2}(?:[-+][\w.-]+)?)\s*$/gm,
        "Terraform", "local CLI declaration",
      );
    }
    if (basename === "gradle-wrapper.properties") {
      addLineObservations(
        observations, repository, branch, file,
        /^\s*distributionUrl\s*=.*?gradle-([\d.]+)-(?:bin|all)\.zip.*$/gm,
        "Gradle", "wrapper version",
      );
    }
    if (basename === "package.json") {
      let pkg;
      try {
        pkg = JSON.parse(file.content);
      } catch {
        pkg = null;
      }
      if (pkg && pkg.engines && pkg.engines.node) {
        const match = file.content.match(/"node"\s*:\s*"([^"]+)"/);
        addObservation(
          observations, repository, branch, file,
          "Node.js", "supported engine range", pkg.engines.node,
          match ? match.index : 0,
        );
      }
      if (typeof (pkg && pkg.packageManager) === "string" && pkg.packageManager.startsWith("yarn@")) {
        const match = file.content.match(/"packageManager"\s*:\s*"yarn@([^"]+)"/);
        addObservation(
          observations, repository, branch, file,
          "Yarn", "package manager version", pkg.packageManager.slice("yarn@".length),
          match ? match.index : 0,
        );
      }
    }
    if (basename === ".yarnrc.yml") {
      addLineObservations(
        observations, repository, branch, file,
        /^\s*yarnPath\s*:\s*["']?[^"'#\r\n]*?yarn-([\d.]+)\.c?js["']?/gmi,
        "Yarn", "configured release",
      );
    }
    if (/(^|\/)\.yarn\/releases\/yarn-[\d.]+\.c?js$/i.test(relativePath)) {
      const match = basename.match(/yarn-([\d.]+)\.c?js$/i);
      if (match) addObservation(observations, repository, branch, file, "Yarn", "vendored release", match[1], 0);
    }
    if (basename === "pom.xml") {
      addLineObservations(
        observations, repository, branch, file,
        /<(java\.version|maven\.compiler\.(?:release|source|target))>\s*([^<]+?)\s*<\/\1>/g,
        "Java", "Maven compile declaration", 2,
      );
      for (const match of file.content.matchAll(/<parent>([\s\S]*?)<\/parent>/g)) {
        const block = match[1];
        if (/org\.springframework\.boot/.test(block) && /spring-boot-starter-parent/.test(block)) {
          const version = block.match(/<version>\s*([^<]+)\s*<\/version>/);
          if (version) {
            const offset = match.index + match[0].indexOf(version[0]);
            addObservation(observations, repository, branch, file, "Spring Boot", "Maven parent version", version[1], offset);
          }
        }
      }
      addLineObservations(
        observations, repository, branch, file,
        /<(?:spring-boot\.version|spring\.boot\.version)>\s*([^<]+?)\s*<\/(?:spring-boot\.version|spring\.boot\.version)>/g,
        "Spring Boot", "Maven property version",
      );
    }
    if (/^build\.gradle(?:\.kts)?$/i.test(basename) || /^settings\.gradle(?:\.kts)?$/i.test(basename)) {
      addLineObservations(
        observations, repository, branch, file,
        /JavaLanguageVersion\.of\(\s*["']?(\d+(?:\.\d+)?)["']?\s*\)/g,
        "Java", "Gradle toolchain version",
      );
      addLineObservations(
        observations, repository, branch, file,
        /(?:sourceCompatibility|targetCompatibility)\s*=\s*(?:JavaVersion\.VERSION_)?["']?(\d+(?:\.\d+)?)/g,
        "Java", "Gradle compile declaration",
      );
      addLineObservations(
        observations, repository, branch, file,
        /id\s*\(?\s*["']org\.springframework\.boot["']\s*\)?\s*version\s*["']([^"']+)["']/g,
        "Spring Boot", "Gradle plugin version",
      );
    }
    if (basename === "libs.versions.toml") {
      addLineObservations(
        observations, repository, branch, file,
        /^\s*(?:spring[-_.]?boot|springBoot)\s*=\s*["']([\d.]+)["']/gmi,
        "Spring Boot", "Gradle version catalog",
      );
    }
    if (basename.endsWith(".tf")) {
      addLineObservations(
        observations, repository, branch, file,
        /^\s*required_version\s*=\s*["']([^"']+)["']/gmi,
        "Terraform", "required CLI constraint",
      );
      for (const match of file.content.matchAll(/\bazurerm\s*=\s*\{([^}]*)\}/g)) {
        const version = match[1].match(/\bversion\s*=\s*["']([^"']+)["']/);
        if (version) {
          const offset = match.index + match[0].indexOf(version[0]);
          addObservation(observations, repository, branch, file, "AzureRM", "provider constraint", version[1], offset);
        }
      }
      addLineObservations(
        observations, repository, branch, file,
        /^\s*provider\s+["']azurerm["']\s*\{[^}]*?\bversion\s*=\s*["']([^"']+)["']/gmi,
        "AzureRM", "provider version",
      );
    }
    if (basename.startsWith("dockerfile")) {
      for (const match of file.content.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+\S+)?/gmi)) {
        const image = match[1];
        const nodeVersion = image.match(/(?:^|\/)node:v?(\d+(?:\.\d+){0,2}(?:-[\w.-]+)?)(?:@|$)/i);
        if (nodeVersion) {
          addObservation(observations, repository, branch, file, "Node.js", "container base image", nodeVersion[1], match.index);
        }
        const javaImage = image.match(/(?:openjdk|eclipse-temurin|amazoncorretto|microsoft-openjdk|zulu-openjdk|semeru|\/java):v?(\d+(?:\.\d+){0,2}(?:-[\w.-]+)?)(?:@|$)/i);
        if (javaImage) {
          addObservation(observations, repository, branch, file, "Java", "container base image", javaImage[1], match.index);
        }
      }
    }
    if (relativePath.startsWith(".github/workflows/")) {
      const lines = file.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const setup = lines[i].match(/uses:\s*actions\/setup-(node|java)@/i);
        if (!setup) continue;
        const technology = setup[1].toLowerCase() === "node" ? "Node.js" : "Java";
        for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
          if (/^\s*-\s*(?:name:|uses:)/.test(lines[j])) break;
          const version = lines[j].match(/^\s*(?:node-version|java-version)\s*:\s*(.+?)\s*$/);
          if (version) {
            addObservation(observations, repository, branch, file, technology, "CI version declaration", version[1], file.content.indexOf(lines[j]));
          }
        }
      }
    }
  }
  return observations;
}

function collectDirectDependencies(repository, branch, files) {
  const documents = [];
  for (const file of files) {
    const basename = path.posix.basename(file.relativePath).toLowerCase();
    const entries = [];
    if (basename === "package.json") {
      let pkg;
      try {
        pkg = JSON.parse(file.content);
      } catch {
        pkg = null;
      }
      for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, version] of Object.entries((pkg && pkg[section]) || {})) {
          const linePattern = new RegExp('["\\x27]' + escapeRegex(name) + '["\\x27]\\s*:\\s*["\\x27]([^"\\x27]+)["\\x27]');
          const match = file.content.match(linePattern);
          const line = match ? lineAt(file.content, match.index) : 1;
          const url = makeFileUrl(repository, branch, file.relativePath, line);
          entries.push("- npm " + section + ": " + name + "@" + version + " — " + url);
        }
      }
    }
    if (basename === "pom.xml") {
      for (const match of file.content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
        const block = match[1];
        const group = block.match(/<groupId>\s*([^<]+)\s*<\/groupId>/);
        const artifact = block.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/);
        const version = block.match(/<version>\s*([^<]+)\s*<\/version>/);
        if (!group || !artifact) continue;
        const line = lineAt(file.content, match.index);
        const url = makeFileUrl(repository, branch, file.relativePath, line);
        entries.push("- Maven dependency: " + group[1] + ":" + artifact[1] + ":" + (version ? version[1] : "managed") + " — " + url);
      }
    }
    if (/^build\.gradle(?:\.kts)?$/i.test(basename)) {
      for (const match of file.content.matchAll(/\b(?:implementation|api|runtimeOnly|compileOnly|testImplementation|testRuntimeOnly|annotationProcessor)\s*(?:\(\s*)?["']([^:"']+):([^:"']+):([^"']+)["']\s*\)?/g)) {
        const line = lineAt(file.content, match.index);
        const url = makeFileUrl(repository, branch, file.relativePath, line);
        entries.push("- Gradle dependency: " + match[1] + ":" + match[2] + ":" + match[3] + " — " + url);
      }
    }
    if (entries.length > 0) {
      documents.push({
        title: repository + ": dependencies in " + file.relativePath,
        url: makeFileUrl(repository, branch, file.relativePath, 1),
        sourceType: "dependency_inventory",
        sourceName: repository,
        content: "Direct dependency declarations for " + repository + " in " + file.relativePath + ":\n" + entries.join("\n"),
      });
    }
  }
  return documents;
}

function buildRepositoryInventory(repository, branch, files) {
  const metadata = catalog.repositories[repository] || {};
  const observations = collectVersionObservations(repository, branch, files);
  const fields = rules.categories[metadata.category] && rules.categories[metadata.category].fields || [];
  const lines = [
    "Repository: " + repository,
    "Category: " + (metadata.category || "Not classified in the supplied tracker"),
    "Type: " + (metadata.type || "Not classified in the supplied tracker"),
    "Purpose: " + (metadata.purpose || "Not supplied"),
    metadata.trackerStatus ? "Tracker note: " + metadata.trackerStatus : "",
    "Current branch scanned: " + branch,
    "",
    "Current version evidence collected from repository files (values in the supplied tracker were not used):",
  ].filter(Boolean);

  if (observations.length > 0) {
    for (const item of observations) {
      lines.push("- " + item.technology + " [" + item.role + "]: " + item.value + " — " + item.url);
    }
  } else {
    lines.push("- No tracked version declarations were detected in the scanned repository files.");
  }

  const observedTechnologies = new Set(observations.map((item) => item.technology));
  for (const field of fields) {
    if (!observedTechnologies.has(field)) {
      lines.push("- " + field + ": " + rules.evidencePolicy.missingEvidenceLabel);
    }
  }

  return {
    title: repository + ": repository technology inventory",
    url: "https://github.com/" + repository,
    sourceType: "repository_inventory",
    sourceName: repository,
    content: lines.join("\n"),
  };
}

module.exports = {
  buildRepositoryInventory,
  collectDirectDependencies,
  isRepositoryMetadataPath,
};


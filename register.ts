import { emitKeypressEvents } from "node:readline";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { auth, database, initializeDatabase } from "./auth.js";

function promptHidden(label: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new Error("El registro requiere una terminal interactiva.");
  }

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(label);

  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      stdin.removeListener("keypress", onKeypress);
      stdin.setRawMode(false);
      stdout.write("\n");
    };

    const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Registro cancelado."));
      } else if (key.name === "return") {
        cleanup();
        resolve(value);
      } else if (key.name === "backspace") {
        value = value.slice(0, -1);
      } else if (character && !key.ctrl) {
        value += character;
      }
    };

    stdin.on("keypress", onKeypress);
  });
}

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Ejecuta este comando desde una terminal interactiva.");
  }
  await initializeDatabase();

  const prompt = createInterface({ input: stdin, output: stdout });
  let name: string;

  try {
    name = (await prompt.question("Nombre: ")).trim();
  } finally {
    prompt.close();
  }

  const password = await promptHidden("PIN (6 dígitos, entrada oculta): ");
  const result = await auth.api.signUpEmail({
    body: { name, username: name, email: `${randomUUID()}@brilliant.invalid`, password },
  });

  console.info(`Usuario registrado: ${result.user.name}`);
}

main()
  .catch((error: unknown) => {
    console.error(
      "No se pudo registrar el usuario:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    database.close();
  });

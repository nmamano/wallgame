/* Configuration script to set up the database.
Whenever the schema changes, run:

bun drizzle-kit generate
bun run migrate

The first command updates the drizzle/ folder, which contains the necessary
migration commands.
The second command runs this file.

On fly deploy, the migration runs automatically via release_command.

The db can be inspected manually by running:
bunx drizzle-kit studio

If you try running it again, you'll get an error saying there is nothing
to migrate:

{
  severity_local: "NOTICE",
  severity: "NOTICE",
  code: "42P06",
  message: "schema \"drizzle\" already exists, skipping",
  file: "schemacmds.c",
  line: "132",
  routine: "CreateSchemaCommand",
}
{
  severity_local: "NOTICE",
  severity: "NOTICE",
  code: "42P07",
  message: "relation \"__drizzle_migrations\" already exists, skipping",
  file: "parse_utilcmd.c",
  line: "207",
  routine: "transformCreateStmt",
}


*/
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const migrationClient = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(migrationClient);

await migrate(db, { migrationsFolder: "drizzle" });
await migrationClient.end();
console.log("Migration complete");

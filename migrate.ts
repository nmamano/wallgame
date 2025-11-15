/* Configuration script to set up the database.
Whenever the schema changes

Run with

bun drizzle-kit generate
bun migrate.ts

The first command updates the drizzle/ folder, which contains the necessary
migration commands.
The second command runs this file.

The db can be inspected manually by running:
bunx drizzle-kit studio

And don't forget to deploy the backend:

fly deploy

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
console.log("Migration complete");

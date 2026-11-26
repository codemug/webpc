## Open a database
slug: open-a-database
summary: Open a .db, .sqlite or .sqlite3 file from the Files app in SQLiteViz.
keywords: open database, sqlite, db file, load database, connect, sql file
tools: desktop.open_app, sqliteviz.open_db

When: the user has a SQLite database file and wants to query it.
Steps:
1. call_tool tool=desktop.open_app app=sqliteviz
2. call_tool tool=sqliteviz.open_db path=/data/shop.db
Check: the result reports the database name shown by the app.
Gotchas: change path=; only .db, .sqlite and .sqlite3 names are accepted (CSV and JSON files take a different import path in the app); the app already has a database open when the error says so, so close it there first.

## List the tables
slug: list-the-tables
summary: List the tables and views of the open database.
keywords: tables, schema, what is in, database structure, list tables
tools: desktop.open_app, sqliteviz.list_tables

When: the user asks what tables a database has, or before writing a query.
Steps:
1. call_tool tool=desktop.open_app app=sqliteviz
2. call_tool tool=sqliteviz.open_db path=/data/shop.db
3. call_tool tool=sqliteviz.list_tables
Check: the result lists the schema names exactly as the app shows them.
Gotchas: a database must be open first; views are listed next to the tables; names are the app's schema names, so use them as-is in queries.

## Run a query
slug: run-a-query
summary: Run a SELECT and report its result table (columns, rows, total row count).
keywords: query, select, run sql, get data, results, sql query
tools: desktop.open_app, sqliteviz.open_db, sqliteviz.run_query

When: the user wants data out of the open database.
Steps:
1. call_tool tool=desktop.open_app app=sqliteviz
2. call_tool tool=sqliteviz.open_db path=/data/shop.db
3. call_tool tool=sqliteviz.list_tables
4. call_tool tool=sqliteviz.run_query sql=SELECT name, value FROM settings LIMIT 5
Check: the result has the columns, the rows and the total row count from the app.
Gotchas: change sql=; the rows are capped at 200 (truncated is true when more were fetched) while rowCount is the app's total; a syntax error comes back as an error with the engine's message, so fix the SQL and retry.

## Modify the data
slug: modify-the-data
summary: Run INSERT, UPDATE or DELETE statements against the open database.
keywords: insert, update, delete, change data, write, modify, dml
tools: desktop.open_app, sqliteviz.run_query

When: the user wants to add, change or remove rows in the open database.
Steps:
1. call_tool tool=desktop.open_app app=sqliteviz
2. call_tool tool=sqliteviz.run_query sql=INSERT INTO settings (name, value) VALUES ('theme', 'dark')
Check: the result reports no rows (DML returns no result table) and the follow-up SELECT shows the change.
Gotchas: change sql=; the statement is applied straight away with no undo; confirm a surprising statement with the user before running it; a statement that affects many rows is best written with a WHERE clause.

## Inspect the schema
slug: inspect-the-schema
summary: Inspect one table's columns and types with PRAGMA and sqlite_master.
keywords: schema, columns, pragma, table info, structure, column types
tools: desktop.open_app, sqliteviz.run_query

When: the user asks what columns a table has, or what their types are.
Steps:
1. call_tool tool=desktop.open_app app=sqliteviz
2. call_tool tool=sqliteviz.list_tables
3. call_tool tool=sqliteviz.run_query sql=PRAGMA table_info(users)
Check: the result has one row per column (name, type, notnull, default, pk).
Gotchas: change the table name to one from sqliteviz.list_tables; for the raw CREATE statements query sqlite_master instead, e.g. SELECT sql FROM sqlite_master WHERE type='table'.

## Find the top customer and add an order for them
slug: top-customer-new-order
summary: Count orders per customer with GROUP BY, take the top customer, INSERT a new order for them and recount.
keywords: most orders, top customer, best customer, new order, count per customer, group by
tools: desktop.open_app, sqliteviz.run_query

When: the user wants the customer with the most orders, and a new order added for that customer.
Steps:
1. call_tool tool=desktop.open_app app=sqliteviz
2. call_tool tool=sqliteviz.run_query sql=SELECT customer_id, COUNT(*) AS n FROM orders GROUP BY customer_id ORDER BY n DESC LIMIT 1
3. call_tool tool=sqliteviz.run_query sql=INSERT INTO orders (customer_id, product_id, amount) VALUES (7, 1, 9.99)
4. call_tool tool=sqliteviz.run_query sql=SELECT COUNT(*) FROM orders WHERE customer_id = 7
Check: step 2 names the top customer id; step 4's count is one more than step 2's n; join customers on id to give the customer's name in the answer.
Gotchas: run the GROUP BY once - repeating the same query changes nothing and only burns rounds; LIMIT 1 stops at the top row instead of reading the whole list; in step 3 use the customer id from step 2, not a guessed one; the answer needs the new total count, not the old one.

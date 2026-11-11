-- Each user's own shortcuts, in their order. Null means the user never chose: the application shows its advised ones.
alter table users
  add column shortcuts text[] check (shortcuts is null or (cardinality(shortcuts) <= 12 and array_position(shortcuts, null) is null));

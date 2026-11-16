-- How the café till relates to the centre's till: closed apart (separate) or counted in the centre's closing (single).
alter table cafe_settings
  add column till_mode text not null default 'separate' check (till_mode in ('separate', 'single'));

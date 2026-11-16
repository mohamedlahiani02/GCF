-- Optional pricing rules a centre may adopt for formats priced per hour: a lower hourly rate from a given length,
-- and a cap after which the booking is no longer charged.
alter table cw_booking_formats
  add column long_from_minutes integer check (long_from_minutes between 30 and 1440),
  add column cap_minutes integer check (cap_minutes between 30 and 1440);
alter table cw_prices
  add column long_amount bigint check (long_amount >= 0);

-- Value added tax shown to companies only, as basis points of the net amount; null when the centre does not show it.
-- Prices stay all taxes included: an individual pays the price, a company sees the same price split into net and tax.
alter table cw_settings
  add column company_tax_bp integer check (company_tax_bp between 1 and 10000);

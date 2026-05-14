-- Migration 003: keep contractors.rating + reviews_count in sync with reviews
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

create or replace function update_contractor_stats()
returns trigger as $$
declare
  target_id bigint;
begin
  target_id := coalesce(new.contractor_id, old.contractor_id);
  update contractors
  set
    rating        = coalesce((select round(avg(stars)::numeric, 1) from reviews where contractor_id = target_id), 0),
    reviews_count = (select count(*) from reviews where contractor_id = target_id)
  where id = target_id;
  return null;
end;
$$ language plpgsql security definer;

drop trigger if exists reviews_update_contractor_stats on reviews;
create trigger reviews_update_contractor_stats
after insert or update or delete on reviews
for each row execute function update_contractor_stats();

-- One-time backfill: replace seeded placeholder counts with real ones.
update contractors c
set
  rating        = coalesce((select round(avg(r.stars)::numeric, 1) from reviews r where r.contractor_id = c.id), 0),
  reviews_count = coalesce((select count(*)::int           from reviews r where r.contractor_id = c.id), 0);

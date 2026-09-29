-- Migration 005: contractor credentials (license + insurance) and verified reviews
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

-- ============================================================
-- CONTRACTOR CREDENTIAL COLUMNS
-- Contractors upload license + insurance so customers can see
-- who they're hiring. Files live in the `credentials` Storage
-- bucket; these columns store metadata + the public URL.
-- ============================================================

alter table contractors add column if not exists license_type          text;
alter table contractors add column if not exists license_number        text;
alter table contractors add column if not exists license_url           text;
alter table contractors add column if not exists insurance_carrier     text;
alter table contractors add column if not exists insurance_expires_at  date;
alter table contractors add column if not exists insurance_url         text;

-- ============================================================
-- REVIEWS: tie each review to the specific job it's about
-- so only the customer who posted the job can review, and
-- only the contractor who accepted it can be reviewed.
-- ============================================================

alter table reviews add column if not exists job_id  bigint references jobs(id)      on delete set null;
alter table reviews add column if not exists user_id uuid   references auth.users(id) on delete set null;

-- Prevent duplicate reviews per (job, contractor)
create unique index if not exists reviews_unique_job_contractor
  on reviews(job_id, contractor_id)
  where job_id is not null;

-- Replace the permissive public-insert policy with a real one:
-- the reviewer must be signed in, they must own the review row,
-- they must be the poster of the referenced job, and that job
-- must have been accepted by the target contractor.
drop policy if exists "public insert reviews" on reviews;
create policy "customers review own jobs" on reviews
  for insert
  with check (
    auth.uid() is not null
    and auth.uid() = user_id
    and exists (
      select 1
      from jobs j
      join contractors c on c.user_id = j.accepted_by
      where j.id = reviews.job_id
        and j.posted_by = auth.uid()
        and c.id = reviews.contractor_id
    )
  );

grant insert (contractor_id, author, stars, text, job_id, user_id) on reviews to authenticated;

-- ============================================================
-- STORAGE BUCKET for license + insurance uploads
-- Public read (customers can view the docs); write only by the
-- owner into their own auth.uid()-prefixed folder.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('credentials', 'credentials', true)
on conflict (id) do nothing;

drop policy if exists "credentials public read"   on storage.objects;
drop policy if exists "credentials owner insert"  on storage.objects;
drop policy if exists "credentials owner update"  on storage.objects;
drop policy if exists "credentials owner delete"  on storage.objects;

create policy "credentials public read" on storage.objects
  for select using (bucket_id = 'credentials');

create policy "credentials owner insert" on storage.objects
  for insert with check (
    bucket_id = 'credentials'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "credentials owner update" on storage.objects
  for update using (
    bucket_id = 'credentials'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "credentials owner delete" on storage.objects
  for delete using (
    bucket_id = 'credentials'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

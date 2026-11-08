-- Starting habits (the Nov 8, 2026 roast list). Edit them in the UI afterwards.

INSERT INTO areas (id, name, roast, sort) VALUES
  ('ship',  'Stay hands-on',       'GitHub looks like a cemetery', 1),
  ('meet',  'Meeting discipline',  '55-minute Quick Sync',         2),
  ('own',   'Own the output',      'Forward it with ''thoughts?''', 3),
  ('tools', 'Tool hygiene',        'Junk drawer with OAuth',       4),
  ('rest',  'Protect recovery',    '8:41 on a Sunday',             5),
  ('lead',  'Thought leadership',  'Thought forwarder',            6);

INSERT INTO habits (id, area_id, text, cadence, sort) VALUES
  ('h1', 'ship',  'Shipped one small thing myself (script, automation, prototype)', 'monthly', 1),
  ('h2', 'ship',  'Built a rough version before greenlighting an AI initiative', 'monthly', 2),
  ('m1', 'meet',  'Every meeting had an agenda and one stated outcome, or went async', 'monthly', 1),
  ('m2', 'meet',  'Defaulted to 25 minutes; ended early when the outcome was reached', 'monthly', 2),
  ('m3', 'meet',  'Left meetings owning at least one action item myself', 'monthly', 3),
  ('o1', 'own',   'Never forwarded AI output raw; led with my own position', 'monthly', 1),
  ('o2', 'own',   'Edited drafts until they sounded like me', 'monthly', 2),
  ('o3', 'own',   'Used Claude to stress-test my thinking, not just generate', 'weekly', 3),
  ('t1', 'tools', 'Audited connectors; disconnected anything unused 60+ days', 'quarterly', 1),
  ('t2', 'tools', 'Every kept tool has one documented job (no overlaps)', 'quarterly', 2),
  ('t3', 'tools', 'Turned a repeated workflow into a skill', 'monthly', 3),
  ('r1', 'rest',  'Held a protected no-work block this weekend', 'weekly', 1),
  ('r2', 'rest',  'Kept personal tinkering inside a set window', 'weekly', 2),
  ('l1', 'lead',  'Wrote one original post or memo (my draft first, AI refined)', 'monthly', 1),
  ('l2', 'lead',  'Opened reviews with my own take before asking others or AI', 'monthly', 2);

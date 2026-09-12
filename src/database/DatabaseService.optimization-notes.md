# Scheduler performance notes

The scheduler intentionally keeps the existing database semantics while parallelizing independent user lookups and notification groups. Future optimization should batch ad existence/price checks into SQL rather than issuing one query per ad.

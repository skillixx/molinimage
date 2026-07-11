ALTER TABLE pricing_rules
  DROP INDEX uk_pricing_rules_task_dimensions,
  DROP COLUMN dimension_key;

UPDATE image_tasks AS image_task
JOIN billing_events AS billing_event
  ON billing_event.id = image_task.billing_event_id
SET image_task.entitlement_id = billing_event.moling_entitlement_id
WHERE image_task.entitlement_id IS NULL
  AND billing_event.event_type = 'reserve'
  AND billing_event.moling_entitlement_id IS NOT NULL;

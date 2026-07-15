-- 回滚本次扩充时只删除 014 新增的 29 个模板。
-- 旧模板由历史 migration 创建，不能在这里删除，避免影响历史任务的 style_preset_id。

DELETE FROM style_presets
WHERE id IN (
  'tti_commercial_photo',
  'tti_ecommerce_main_image',
  'tti_xiaohongshu_cover',
  'tti_douyin_cover',
  'tti_realistic_photo',
  'tti_chinese_style',
  'tti_anime_style',
  'tti_children_book',
  'tti_watercolor',
  'tti_oil_painting',
  'tti_cyberpunk',
  'tti_minimal_premium',
  'tti_3d_render',
  'tti_logo_icon',
  'tti_movie_poster',
  'edit_scene_replace',
  'edit_outfit_change',
  'edit_hair_style',
  'edit_season_change',
  'edit_lighting',
  'edit_to_chinese_style',
  'edit_to_anime',
  'edit_product_refine',
  'restore_portrait_enhance',
  'restore_low_light',
  'restore_low_resolution',
  'restore_background_extend',
  'restore_color_repair',
  'restore_detail_enhance'
);

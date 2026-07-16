-- 扩充默认风格模板库：新增 29 个运营模板，并校准旧模板分类/排序。
-- 这里不保存任何密钥或供应商配置，只写可公开展示的模板元数据和提示词。

INSERT INTO style_presets (
  id, name, category, task_type, prompt_template, preview_image_url, enabled, sort_order
) VALUES
  ('tti_commercial_photo', '商业摄影', 'product', 'text_to_image', '以商业摄影风格呈现，主体质感清晰，布光精致，画面干净高级，背景与主体形成明确层次，适合品牌视觉和营销物料。', 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=640&q=80', 1, 20),
  ('tti_ecommerce_main_image', '电商主图', 'product', 'text_to_image', '以电商主图风格呈现，主体居中且清晰完整，背景简洁干净，光线均匀，突出商品外观、材质和卖点，适合商品展示。', 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=640&q=80', 1, 30),
  ('tti_xiaohongshu_cover', '小红书封面', 'social', 'text_to_image', '以小红书封面风格呈现，画面明亮清爽，主体突出，色彩柔和有生活方式氛围，构图适合社媒种草内容。', 'https://images.unsplash.com/photo-1499750310107-5fef28a66643?auto=format&fit=crop&w=640&q=80', 1, 40),
  ('tti_douyin_cover', '抖音视频封面', 'social', 'text_to_image', '以短视频封面风格呈现，主体醒目，构图有冲击力，色彩对比明确，画面适合移动端竖屏浏览和快速吸引注意。', 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=640&q=80', 1, 50),
  ('tti_realistic_photo', '写实摄影', 'portrait', 'text_to_image', '以真实摄影风格呈现，主体自然可信，镜头质感真实，光线柔和，背景层次自然，避免过度塑料感、假细节和夸张特效。', 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80', 1, 70),
  ('tti_chinese_style', '国风插画', 'chinese', 'text_to_image', '以东方国风插画风格呈现，融合传统纹样、雅致配色、柔和留白和细腻线条，画面具有古典审美和现代精致感。', 'https://images.unsplash.com/photo-1528181304800-259b08848526?auto=format&fit=crop&w=640&q=80', 1, 80),
  ('tti_anime_style', '二次元', 'anime', 'text_to_image', '以高质量二次元插画风格呈现，线条干净，角色或主体精致，色彩鲜明，光影柔和，画面具有动漫作品的完成度。', 'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=640&q=80', 1, 90),
  ('tti_children_book', '儿童绘本', 'illustration', 'text_to_image', '以儿童绘本插画风格呈现，画面温暖友好，角色可爱，色彩柔和，构图简单易懂，适合儿童故事和亲子内容。', 'https://images.unsplash.com/photo-1519682337058-a94d519337bc?auto=format&fit=crop&w=640&q=80', 1, 110),
  ('tti_watercolor', '水彩插画', 'illustration', 'text_to_image', '以水彩插画风格呈现，色彩轻盈透明，边缘柔和，笔触自然，画面具有文艺、清新和手绘质感。', 'https://images.unsplash.com/photo-1459908676235-d5f02a50184b?auto=format&fit=crop&w=640&q=80', 1, 120),
  ('tti_oil_painting', '油画质感', 'illustration', 'text_to_image', '以油画质感呈现，笔触丰富，色彩层次厚重，光影具有绘画感，画面带有艺术肖像或经典绘画氛围。', 'https://images.unsplash.com/photo-1547891654-e66ed7ebb968?auto=format&fit=crop&w=640&q=80', 1, 130),
  ('tti_cyberpunk', '赛博朋克', 'poster', 'text_to_image', '以赛博朋克风格呈现，霓虹光效、未来城市、强烈冷暖对比和科技细节突出，画面具有科幻氛围和视觉冲击力。', 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=640&q=80', 1, 140),
  ('tti_minimal_premium', '极简高级感', 'design', 'text_to_image', '以极简高级感风格呈现，留白充足，构图克制，色彩低饱和，材质和光影精致，适合品牌图、封面和高级宣传视觉。', 'https://images.unsplash.com/photo-1494438639946-1ebd1d20bf85?auto=format&fit=crop&w=640&q=80', 1, 150),
  ('tti_3d_render', '3D 渲染', 'render', 'text_to_image', '以高质量 3D 渲染风格呈现，主体结构清晰，材质细腻，光线真实，空间层次明确，适合产品渲染和 IP 形象创作。', 'https://images.unsplash.com/photo-1633419461186-7d40a38105ec?auto=format&fit=crop&w=640&q=80', 1, 160),
  ('tti_logo_icon', 'Logo / 图标', 'design', 'text_to_image', '以简洁图标和品牌标识草案风格呈现，轮廓清晰，形状易识别，视觉元素简洁有记忆点，避免复杂背景和过多文字。', 'https://images.unsplash.com/photo-1618005198919-d3d4b5a92ead?auto=format&fit=crop&w=640&q=80', 1, 170),
  ('tti_movie_poster', '电影海报', 'poster', 'text_to_image', '以电影海报风格呈现，画面具有故事感和戏剧张力，主体明确，光影对比强，构图适合宣传海报和视觉封面。', 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=640&q=80', 1, 180),
  ('edit_scene_replace', '保持主体换场景', 'scene', 'image_to_image', '请基于参考图生成新图，保持主体身份、结构、姿态和核心视觉特征不变，将背景或环境替换为新的场景，并保持光影自然一致。', 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80', 1, 50),
  ('edit_outfit_change', '换服装', 'portrait', 'image_to_image', '请基于参考图生成新图，尽量保持人物身份、脸部特征、姿态和构图不变，只调整服装款式、材质和搭配，使整体自然协调。', 'https://images.unsplash.com/photo-1496747611176-843222e1e57c?auto=format&fit=crop&w=640&q=80', 1, 60),
  ('edit_hair_style', '换发型', 'portrait', 'image_to_image', '请基于参考图生成新图，保持人物身份、脸部特征和整体气质不变，只调整发型、发色或发丝细节，避免改变五官。', 'https://images.unsplash.com/photo-1522338242992-e1a54906a8da?auto=format&fit=crop&w=640&q=80', 1, 70),
  ('edit_season_change', '换季节', 'scene', 'image_to_image', '请基于参考图生成新图，保持主体和构图关系不变，将场景氛围转换为指定季节，调整环境元素、色彩、光线和细节。', 'https://images.unsplash.com/photo-1477414348463-c0eb7f1359b6?auto=format&fit=crop&w=640&q=80', 1, 80),
  ('edit_lighting', '换光影', 'light', 'image_to_image', '请基于参考图生成新图，保持主体和画面结构不变，重点调整光线方向、明暗层次、氛围色和阴影细节，使画面更有质感。', 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=640&q=80', 1, 90),
  ('edit_to_chinese_style', '转国风', 'style', 'image_to_image', '请基于参考图生成新图，保持主体识别度和构图关系，将整体转换为东方国风视觉，加入雅致配色、传统纹样和细腻线条。', 'https://images.unsplash.com/photo-1528181304800-259b08848526?auto=format&fit=crop&w=640&q=80', 1, 100),
  ('edit_to_anime', '转动漫', 'style', 'image_to_image', '请基于参考图生成新图，保持主体身份和核心特征，将整体转换为高质量动漫插画风格，线条清晰，色彩鲜明，光影自然。', 'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=640&q=80', 1, 110),
  ('edit_product_refine', '商品图精修', 'product', 'image_to_image', '请基于参考商品图进行精修，保持商品结构、比例和品牌特征不变，优化光线、材质、背景和构图，使画面更适合电商展示。', 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=640&q=80', 1, 120),
  ('restore_portrait_enhance', '人像增强', 'portrait', 'image_restore', '请在保持人物身份、五官比例和真实质感的前提下，增强人像清晰度、肤色自然度和局部细节，避免磨皮过度或五官变形。', 'https://images.unsplash.com/photo-1496747611176-843222e1e57c?auto=format&fit=crop&w=640&q=80', 1, 50),
  ('restore_low_light', '暗光增强', 'quality', 'image_restore', '请增强暗光图片的可见度，提升暗部细节和整体亮度，降低噪点，同时保持自然光影和真实色彩。', 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=640&q=80', 1, 60),
  ('restore_low_resolution', '低清晰度增强', 'quality', 'image_restore', '请增强低清晰度图片，提升主体边缘、纹理和局部细节，减少压缩痕迹，保持画面自然，不要生成不真实细节。', 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=640&q=80', 1, 70),
  ('restore_background_extend', '背景补全', 'background', 'image_restore', '请基于原图内容自然补全画面边缘和背景缺失区域，保持透视、纹理、光线和整体风格一致。', 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80', 1, 80),
  ('restore_color_repair', '色彩修复', 'color', 'image_restore', '请修复图片偏色、褪色和不自然色彩，校正白平衡、饱和度和对比度，使画面色彩自然、稳定且真实。', 'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=640&q=80', 1, 90),
  ('restore_detail_enhance', '细节增强', 'quality', 'image_restore', '请增强图片细节和纹理表现，改善边缘清晰度和局部层次，同时避免过度锐化、噪点放大和伪影。', 'https://images.unsplash.com/photo-1547891654-e66ed7ebb968?auto=format&fit=crop&w=640&q=80', 1, 100)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  category = VALUES(category),
  task_type = VALUES(task_type),
  prompt_template = VALUES(prompt_template),
  preview_image_url = VALUES(preview_image_url),
  enabled = VALUES(enabled),
  sort_order = VALUES(sort_order);

-- 旧模板 ID 保持不变，只按扩充规划校准分类和排序，避免影响历史任务引用。
UPDATE style_presets SET category = 'product', sort_order = 10 WHERE id = 'tti_product_poster';
UPDATE style_presets SET category = 'portrait', sort_order = 60 WHERE id = 'tti_portrait_editorial';
UPDATE style_presets SET category = 'illustration', sort_order = 100 WHERE id = 'tti_illustration_flat';
UPDATE style_presets SET category = 'edit', sort_order = 10 WHERE id = 'keep_subject';
UPDATE style_presets SET category = 'scene', sort_order = 20 WHERE id = 'change_background';
UPDATE style_presets SET category = 'style', sort_order = 30 WHERE id = 'change_style';
UPDATE style_presets SET category = 'edit', sort_order = 40 WHERE id = 'variation';
UPDATE style_presets SET category = 'restore', sort_order = 10 WHERE id = 'old_photo';
UPDATE style_presets SET category = 'quality', sort_order = 20 WHERE id = 'denoise';
UPDATE style_presets SET category = 'quality', sort_order = 30 WHERE id = 'deblur';
UPDATE style_presets SET category = 'color', sort_order = 40 WHERE id = 'color_enhance';

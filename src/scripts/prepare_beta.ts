import "dotenv/config";
import { supabase } from "../lib/supabase";
import { PRIVATE_BUCKET } from "../services/media";
(async () => {
  const { data: bucket } = await supabase.storage.getBucket(PRIVATE_BUCKET);
  if (!bucket) {
    const { error } = await supabase.storage.createBucket(PRIVATE_BUCKET, {
      public: false,
      fileSizeLimit: 20 * 1024 * 1024,
      allowedMimeTypes: ["image/jpeg", "image/png"],
    });
    if (error) throw Error("Could not create private photo bucket");
  } else if (bucket.public)
    throw Error("The private photo bucket must not be public");
  console.log("Private photo storage is ready.");
})().catch(() => {
  console.error("Private storage preparation failed.");
  process.exitCode = 1;
});


import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error("Server configuration is incomplete.");
    }

    // 1. Authenticate customer
    const authorization = req.headers.get("Authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "");

    if (!token || token === authorization) {
      return jsonResponse({
        error: "Sila log masuk terlebih dahulu.",
      }, 401);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: authData, error: authError } =
      await authClient.auth.getUser(token);

    if (authError || !authData.user) {
      return jsonResponse({
        error: "Sesi login tidak sah.",
      }, 401);
    }

    const user = authData.user;

    // 2. Read requested order item
    const body = await req.json();
    const orderItemId = String(body.orderItemId || "").trim();

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(orderItemId)
    ) {
      return jsonResponse({
        error: "ID item pesanan tidak sah.",
      }, 400);
    }

    // 3. Use server-side service role
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // 4. Verify order ownership and payment
    const { data: orderItem, error: itemError } = await admin
      .from("order_items")
      .select(`
        id,
        product_id,
        product_title,
        orders!inner (
          id,
          customer_id,
          payment_status,
          status
        )
      `)
      .eq("id", orderItemId)
      .maybeSingle();

    if (itemError) {
      console.error("Order item lookup:", itemError.message);
      throw new Error("Tidak dapat menyemak pesanan.");
    }

    if (!orderItem) {
      return jsonResponse({
        error: "Rekod pesanan tidak ditemui.",
      }, 404);
    }

    const order = Array.isArray(orderItem.orders)
      ? orderItem.orders[0]
      : orderItem.orders;

    if (!order || order.customer_id !== user.id) {
      return jsonResponse({
        error: "Anda tidak dibenarkan mengakses pesanan ini.",
      }, 403);
    }

    if (String(order.payment_status).toLowerCase() !== "paid") {
      return jsonResponse({
        error: "Pembayaran belum disahkan. Muat turun tidak dibenarkan.",
      }, 403);
    }

    // 5. Get the product's private file path
    const { data: product, error: productError } = await admin
      .from("products")
      .select("id, title, file_path, is_active")
      .eq("id", orderItem.product_id)
      .maybeSingle();

    if (productError) {
      throw new Error("Tidak dapat menyemak fail produk.");
    }

    if (!product || !product.file_path) {
      return jsonResponse({
        error: "Fail digital produk tidak tersedia.",
      }, 404);
    }

    // 6. Generate temporary signed download URL
    const { data: signedFile, error: signedError } = await admin
      .storage
      .from("digital-files")
      .createSignedUrl(
        product.file_path,
        300,
        {
          download: true,
        },
      );

    if (signedError || !signedFile?.signedUrl) {
      console.error("Signed URL error:", signedError?.message);
      throw new Error("Pautan muat turun gagal dijana.");
    }

    return jsonResponse({
      success: true,
      download_url: signedFile.signedUrl,
      file_name: product.title || orderItem.product_title,
      expires_in: 300,
    });

  } catch (error) {
    console.error("snna-download:", error);

    return jsonResponse({
      error: error instanceof Error
        ? error.message
        : "Ralat server. Sila cuba lagi.",
    }, 500);
  }
});

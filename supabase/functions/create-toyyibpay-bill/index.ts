
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });

const cleanPhone = (value: string) => value.replace(/\D/g, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  let orderId: string | null = null;

  try {
    // 1. Baca konfigurasi server
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const toyyibSecret = Deno.env.get("TOYYIBPAY_SECRET_KEY");
    const categoryCode = Deno.env.get("TOYYIBPAY_CATEGORY_CODE");

    if (
      !supabaseUrl ||
      !anonKey ||
      !serviceRoleKey ||
      !toyyibSecret ||
      !categoryCode
    ) {
      return jsonResponse({
        error: "Konfigurasi pembayaran server belum lengkap.",
      }, 500);
    }

    // 2. Sahkan sesi pelanggan
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
        error: "Sesi login tidak sah. Sila log masuk semula.",
      }, 401);
    }

    const user = authData.user;

    if (!user.email) {
      return jsonResponse({
        error: "Alamat email akaun tidak tersedia.",
      }, 400);
    }

    // 3. Baca maklumat checkout
    const body = await req.json();

    const customerName = String(body.customerName || "").trim();
    const customerPhone = cleanPhone(
      String(body.customerPhone || ""),
    );

    const requestedItems = body.items;

    if (customerName.length < 2 || customerName.length > 100) {
      return jsonResponse({
        error: "Sila masukkan nama pelanggan yang sah.",
      }, 400);
    }

    if (!/^\d{9,15}$/.test(customerPhone)) {
      return jsonResponse({
        error: "Nombor telefon tidak sah.",
      }, 400);
    }

    if (
      !Array.isArray(requestedItems) ||
      requestedItems.length < 1 ||
      requestedItems.length > 20
    ) {
      return jsonResponse({
        error: "Senarai produk tidak sah.",
      }, 400);
    }

    // 4. Semak ID produk dan kuantiti
    const quantityMap = new Map<string, number>();

    for (const item of requestedItems) {
      const productId = String(item.productId || "").trim();
      const quantity = Number(item.quantity);

      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          .test(productId) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      ) {
        return jsonResponse({
          error: "Maklumat produk atau kuantiti tidak sah.",
        }, 400);
      }

      quantityMap.set(
        productId,
        (quantityMap.get(productId) || 0) + quantity,
      );

      if (quantityMap.get(productId)! > 10) {
        return jsonResponse({
          error: "Kuantiti produk melebihi had.",
        }, 400);
      }
    }

    const productIds = [...quantityMap.keys()];

    // 5. Client server dengan service role
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // Harga diambil terus daripada database.
    const { data: products, error: productError } = await admin
      .from("products")
      .select("id,title,price,is_active")
      .in("id", productIds);

    if (productError) {
      throw new Error("Tidak dapat menyemak produk.");
    }

    if (!products || products.length !== productIds.length) {
      return jsonResponse({
        error: "Satu atau lebih produk tidak ditemui.",
      }, 400);
    }

    let subtotal = 0;

    const orderItems = [];

    for (const product of products) {
      if (product.is_active !== true) {
        return jsonResponse({
          error: "Produk tidak lagi tersedia.",
        }, 400);
      }

      const price = Number(product.price);
      const quantity = quantityMap.get(product.id) || 0;

      if (
        !Number.isFinite(price) ||
        price <= 0 ||
        !Number.isInteger(quantity) ||
        quantity < 1
      ) {
        return jsonResponse({
          error: "Harga atau kuantiti produk tidak sah.",
        }, 400);
      }

      subtotal += price * quantity;

      orderItems.push({
        product_id: product.id,
        product_title: String(product.title || "Produk Digital"),
        unit_price: price,
        quantity,
      });
    }

    const total = Number(subtotal.toFixed(2));
    const amountInSen = Math.round(total * 100);

    // Dokumentasi ToyyibPay menyatakan jumlah bil
    // perlu melebihi RM1.00.
    if (amountInSen <= 100) {
      return jsonResponse({
        error: "Jumlah pembayaran mestilah melebihi RM1.00.",
      }, 400);
    }

    // 6. Cipta nombor pesanan unik
    const randomPart = crypto.randomUUID()
      .replace(/-/g, "")
      .slice(0, 6)
      .toUpperCase();

    const orderNumber =
      "SNNA" + Date.now().toString().slice(-8) + randomPart;

    // 7. Simpan pesanan sebagai pending
    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({
        order_number: orderNumber,
        customer_id: user.id,
        customer_name: customerName,
        customer_email: user.email,
        customer_phone: customerPhone,
        currency: "MYR",
        subtotal,
        discount: 0,
        total,
        status: "pending",
        payment_status: "pending",
        payment_provider: "toyyibpay",
      })
      .select("id,order_number,total")
      .single();

    if (orderError || !order) {
      throw new Error("Pesanan tidak dapat disimpan.");
    }

    orderId = order.id;

    // 8. Simpan item pesanan
    const itemsToInsert = orderItems.map((item) => ({
      ...item,
      order_id: order.id,
    }));

    const { error: itemsError } = await admin
      .from("order_items")
      .insert(itemsToInsert);

    if (itemsError) {
      await admin.from("orders").delete().eq("id", order.id);
      orderId = null;
      throw new Error("Butiran pesanan tidak dapat disimpan.");
    }

    // 9. Sediakan permintaan ToyyibPay LIVE
    const paymentData = new URLSearchParams();

    paymentData.set("userSecretKey", toyyibSecret);
    paymentData.set("categoryCode", categoryCode);
    paymentData.set("billName", "SNNA Order");
    paymentData.set(
      "billDescription",
      "SNNA Digital Product Order",
    );
    paymentData.set("billPriceSetting", "1");
    paymentData.set("billPayorInfo", "1");
    paymentData.set("billAmount", String(amountInSen));
    paymentData.set("billTo", customerName);
    paymentData.set("billEmail", user.email);
    paymentData.set("billPhone", customerPhone);
    paymentData.set("billExternalReferenceNo", orderNumber);

    // URL ini hanya digunakan jika telah dikonfigurasi
    // selepas halaman return dan callback disediakan.
    const returnUrl = Deno.env.get("SNNA_PAYMENT_RETURN_URL");
    const callbackUrl = Deno.env.get("SNNA_PAYMENT_CALLBACK_URL");

    if (returnUrl) {
      paymentData.set("billReturnUrl", returnUrl);
    }

    if (callbackUrl) {
      paymentData.set("billCallbackUrl", callbackUrl);
    }

    // 10. Cipta bil di ToyyibPay LIVE
    const paymentResponse = await fetch(
      "https://toyyibpay.com/index.php/api/createBill",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: paymentData.toString(),
      },
    );

    const responseText = await paymentResponse.text();

    let billCode: string | null = null;

    try {
      const result = JSON.parse(responseText);

      if (Array.isArray(result)) {
        billCode = result[0]?.BillCode || null;
      } else if (result?.BillCode) {
        billCode = result.BillCode;
      } else if (result?.status === "error") {
        throw new Error(
          result.msg || "ToyyibPay menolak permintaan bil.",
        );
      }
    } catch (parseError) {
      if (parseError instanceof Error &&
          parseError.message.includes("ToyyibPay")) {
        throw parseError;
      }
    }

    if (!paymentResponse.ok || !billCode) {
      console.error(
        "ToyyibPay createBill failed:",
        responseText.slice(0, 500),
      );

      throw new Error(
        "Bil pembayaran tidak berjaya dicipta. Sila cuba lagi.",
      );
    }

    // 11. Simpan BillCode dan URL pembayaran
    const paymentUrl = `https://toyyibpay.com/${encodeURIComponent(billCode)}`;

    const { error: updateError } = await admin
      .from("orders")
      .update({
        payment_reference: billCode,
        payment_url: paymentUrl,
      })
      .eq("id", order.id);

    if (updateError) {
      console.error("Order payment update:", updateError.message);
      throw new Error(
        "Bil telah dicipta tetapi rekod pembayaran gagal dikemaskini. Hubungi admin.",
      );
    }

    // 12. Pulangkan URL kepada frontend
    return jsonResponse({
      success: true,
      order_id: order.id,
      order_number: order.order_number,
      payment_url: paymentUrl,
      amount: total,
      currency: "MYR",
      payment_status: "pending",
    });

  } catch (error) {
    console.error(
      "create-toyyibpay-bill:",
      error instanceof Error ? error.message : error,
    );

    // Jika ToyyibPay gagal sebelum billCode disimpan,
    // tandakan pesanan sebagai gagal.
    if (orderId) {
      const url = Deno.env.get("SUPABASE_URL");
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

      if (url && serviceKey) {
        const admin = createClient(url, serviceKey);

        await admin
          .from("orders")
          .update({
            status: "failed",
            payment_status: "failed",
          })
          .eq("id", orderId)
          .is("payment_reference", null);
      }
    }

    return jsonResponse({
      error: error instanceof Error
        ? error.message
        : "Ralat server. Sila cuba lagi.",
    }, 500);
  }
});

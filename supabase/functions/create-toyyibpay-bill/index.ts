
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

function cleanPhone(value: string) {
  return value.replace(/\D/g, "");
}

function toCents(value: unknown): number | null {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const cents = Math.round(amount * 100);

  return Number.isSafeInteger(cents) ? cents : null;
}

function validHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;

  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({
      success: false,
      error: "Method not allowed.",
    }, 405);
  }

  let orderId: string | null = null;
  let billCreated = false;
  let createdBillCode: string | null = null;
  let createdOrderNumber: string | null = null;

  try {
    // 1. Read server configuration
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const toyyibSecret = Deno.env.get("TOYYIBPAY_SECRET_KEY");
    const categoryCode = Deno.env.get("TOYYIBPAY_CATEGORY_CODE");

    const returnUrl = Deno.env.get("SNNA_PAYMENT_RETURN_URL");
    const callbackUrl = Deno.env.get("SNNA_PAYMENT_CALLBACK_URL");

    if (
      !supabaseUrl ||
      !anonKey ||
      !serviceRoleKey ||
      !toyyibSecret ||
      !categoryCode
    ) {
      return jsonResponse({
        success: false,
        error: "Konfigurasi pembayaran server belum lengkap.",
      }, 500);
    }

    // Both URLs are mandatory before creating a LIVE bill.
    if (
      !validHttpsUrl(returnUrl) ||
      !validHttpsUrl(callbackUrl)
    ) {
      return jsonResponse({
        success: false,
        error: "URL return atau callback belum dikonfigurasi dengan betul.",
      }, 500);
    }

    // 2. Verify customer session
    const authorization = req.headers.get("Authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "");

    if (!token || token === authorization) {
      return jsonResponse({
        success: false,
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
        success: false,
        error: "Sesi login tidak sah. Sila log masuk semula.",
      }, 401);
    }

    const user = authData.user;

    if (!user.email) {
      return jsonResponse({
        success: false,
        error: "Alamat email akaun tidak tersedia.",
      }, 400);
    }

    // 3. Validate checkout input
    const body = await req.json();

    const customerName = String(body.customerName || "").trim();
    const customerPhone = cleanPhone(
      String(body.customerPhone || ""),
    );

    const requestedItems = body.items;

    if (customerName.length < 2 || customerName.length > 100) {
      return jsonResponse({
        success: false,
        error: "Sila masukkan nama pelanggan yang sah.",
      }, 400);
    }

    if (!/^\d{9,15}$/.test(customerPhone)) {
      return jsonResponse({
        success: false,
        error: "Nombor telefon tidak sah.",
      }, 400);
    }

    if (
      !Array.isArray(requestedItems) ||
      requestedItems.length < 1 ||
      requestedItems.length > 20
    ) {
      return jsonResponse({
        success: false,
        error: "Senarai produk tidak sah.",
      }, 400);
    }

    // 4. Validate product IDs and quantities
    const quantityMap = new Map<string, number>();

    for (const item of requestedItems) {
      const productId = String(item?.productId || "").trim();
      const quantity = Number(item?.quantity);

      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          .test(productId) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      ) {
        return jsonResponse({
          success: false,
          error: "Maklumat produk atau kuantiti tidak sah.",
        }, 400);
      }

      const newQuantity =
        (quantityMap.get(productId) || 0) + quantity;

      if (newQuantity > 10) {
        return jsonResponse({
          success: false,
          error: "Kuantiti produk melebihi had.",
        }, 400);
      }

      quantityMap.set(productId, newQuantity);
    }

    const productIds = [...quantityMap.keys()];

    // 5. Create admin client
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // Always obtain product prices from database.
    const { data: products, error: productError } = await admin
      .from("products")
      .select("id,title,price,is_active")
      .in("id", productIds);

    if (productError) {
      throw new Error("Tidak dapat menyemak produk.");
    }

    if (!products || products.length !== productIds.length) {
      return jsonResponse({
        success: false,
        error: "Satu atau lebih produk tidak ditemui.",
      }, 400);
    }

    // 6. Calculate total using integer sen
    let subtotalCents = 0;

    const orderItems = [];

    for (const product of products) {
      if (product.is_active !== true) {
        return jsonResponse({
          success: false,
          error: "Produk tidak lagi tersedia.",
        }, 400);
      }

      const priceCents = toCents(product.price);
      const quantity = quantityMap.get(product.id) || 0;

      if (
        priceCents === null ||
        !Number.isInteger(quantity) ||
        quantity < 1
      ) {
        return jsonResponse({
          success: false,
          error: "Harga atau kuantiti produk tidak sah.",
        }, 400);
      }

      const itemTotal = priceCents * quantity;

      if (!Number.isSafeInteger(itemTotal)) {
        return jsonResponse({
          success: false,
          error: "Jumlah produk terlalu besar.",
        }, 400);
      }

      subtotalCents += itemTotal;

      if (!Number.isSafeInteger(subtotalCents)) {
        return jsonResponse({
          success: false,
          error: "Jumlah pesanan tidak sah.",
        }, 400);
      }

      orderItems.push({
        product_id: product.id,
        product_title: String(
          product.title || "Produk Digital"
        ),
        unit_price: priceCents / 100,
        quantity,
      });
    }

    const amountInSen = subtotalCents;
    const total = subtotalCents / 100;

    if (amountInSen <= 100) {
      return jsonResponse({
        success: false,
        error: "Jumlah pembayaran mestilah melebihi RM1.00.",
      }, 400);
    }

    // 7. Generate unique order number
    const randomPart = crypto.randomUUID()
      .replace(/-/g, "")
      .slice(0, 12)
      .toUpperCase();

    const orderNumber =
      "SNNA" + Date.now().toString().slice(-8) + randomPart;

    createdOrderNumber = orderNumber;

    // 8. Insert pending order
    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({
        order_number: orderNumber,
        customer_id: user.id,
        customer_name: customerName,
        customer_email: user.email,
        customer_phone: customerPhone,
        currency: "MYR",
        subtotal: total,
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

    // 9. Insert order items
    const itemsToInsert = orderItems.map((item) => ({
      ...item,
      order_id: order.id,
    }));

    const { error: itemsError } = await admin
      .from("order_items")
      .insert(itemsToInsert);

    if (itemsError) {
      throw new Error("Butiran pesanan tidak dapat disimpan.");
    }

    // 10. Prepare ToyyibPay LIVE request
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
    paymentData.set("billReturnUrl", returnUrl);
    paymentData.set("billCallbackUrl", callbackUrl);

    // 11. Create ToyyibPay LIVE bill
    const paymentResponse = await fetch(
      "https://toyyibpay.com/index.php/api/createBill",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: paymentData.toString(),
        signal: AbortSignal.timeout(25000),
      },
    );

    const responseText = await paymentResponse.text();

    if (!paymentResponse.ok) {
      console.error(
        "ToyyibPay HTTP error:",
        paymentResponse.status,
        responseText.slice(0, 500),
      );

      throw new Error(
        "ToyyibPay tidak dapat memproses permintaan bil.",
      );
    }

    let result: any;

    try {
      result = JSON.parse(responseText);
    } catch {
      console.error(
        "Invalid ToyyibPay response:",
        responseText.slice(0, 500),
      );

      throw new Error(
        "Respons ToyyibPay tidak dapat dibaca.",
      );
    }

    // ToyyibPay commonly returns an array containing BillCode.
    const billCodeValue = Array.isArray(result)
      ? result[0]?.BillCode
      : result?.BillCode;

    const billCode =
      typeof billCodeValue === "string"
        ? billCodeValue.trim()
        : "";

    if (
      !billCode ||
      !/^[a-zA-Z0-9]+$/.test(billCode)
    ) {
      console.error(
        "ToyyibPay bill creation rejected:",
        responseText.slice(0, 500),
      );

      throw new Error(
        "ToyyibPay tidak memulangkan BillCode yang sah.",
      );
    }

    // From this point onward, a LIVE bill may exist.
    // Never automatically mark this order as failed.
    billCreated = true;
    createdBillCode = billCode;

    const paymentUrl =
      `https://toyyibpay.com/${encodeURIComponent(billCode)}`;

    // 12. Save BillCode and payment URL
    const { data: updatedOrder, error: updateError } =
      await admin
        .from("orders")
        .update({
          payment_reference: billCode,
          payment_url: paymentUrl,
        })
        .eq("id", order.id)
        .eq("payment_status", "pending")
        .select("id")
        .maybeSingle();

    if (updateError || !updatedOrder) {
      console.error(
        "CRITICAL: ToyyibPay bill created but order update failed.",
        {
          orderNumber,
          billCode,
          error: updateError?.message || "No row updated",
        },
      );

      throw new Error(
        "Bil pembayaran telah dicipta tetapi rekod belum berjaya dikemas kini. Jangan buat pembayaran berulang. Sila hubungi admin.",
      );
    }

    // 13. Return payment URL to frontend
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
      "create-toyyibpay-bill error:",
      error instanceof Error ? error.message : error,
    );

    // Only mark failed when we know no LIVE bill was created.
    if (orderId && !billCreated) {
      const url = Deno.env.get("SUPABASE_URL");
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

      if (url && serviceKey) {
        const admin = createClient(url, serviceKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        });

        const { error: cleanupError } = await admin
          .from("orders")
          .update({
            status: "failed",
            payment_status: "failed",
          })
          .eq("id", orderId)
          .eq("payment_status", "pending")
          .is("payment_reference", null);

        if (cleanupError) {
          console.error(
            "Unable to mark failed order:",
            cleanupError.message,
          );
        }
      }
    }

    // A bill may exist even if saving its reference failed.
    // Log identifiers for admin recovery; do not expose secrets.
    if (billCreated) {
      console.error(
        "MANUAL PAYMENT RECONCILIATION REQUIRED:",
        {
          orderNumber: createdOrderNumber,
          billCode: createdBillCode,
          orderId,
        },
      );
    }

    return jsonResponse({
      success: false,
      error: error instanceof Error
        ? error.message
        : "Ralat server. Sila cuba lagi.",
      manual_review_required: billCreated,
    }, billCreated ? 503 : 500);
  }
});

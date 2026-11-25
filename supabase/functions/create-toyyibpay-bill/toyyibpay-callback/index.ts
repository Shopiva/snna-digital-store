
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHash } from "node:crypto";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getField(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function md5(value: string): string {
  return createHash("md5")
    .update(value, "utf8")
    .digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

function toCents(value: unknown): number | null {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return Math.round(amount * 100);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({
      success: false,
      message: "Method not allowed",
    }, 405);
  }

  if (Deno.env.get("SNNA_LIVE_CHECKOUT_ENABLED") !== "true") {
    return jsonResponse({
      success: false,
      message: "Live checkout is currently disabled.",
    }, 403);
  }


    );
    }
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({
      success: false,
      message: "Method not allowed",
    }, 405);
  }

  try {
    const secretKey = Deno.env.get("TOYYIBPAY_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!secretKey || !supabaseUrl || !serviceRoleKey) {
      throw new Error("Server configuration is incomplete.");
    }

    const form = await req.formData();

    const refno = getField(form, "refno");
    const status = getField(form, "status");
    const billCode = getField(form, "billcode");
    const orderNumber = getField(form, "order_id");
    const receivedHash = getField(form, "hash");

    if (
      !refno ||
      !status ||
      !billCode ||
      !orderNumber ||
      !receivedHash
    ) {
      return jsonResponse({
        success: false,
        message: "Missing callback fields",
      }, 400);
    }

    // 1. Verify ToyyibPay callback hash
    const expectedHash = md5(
      secretKey + status + orderNumber + refno + "ok"
    );

    if (!safeEqual(
      receivedHash.toLowerCase(),
      expectedHash.toLowerCase()
    )) {
      return jsonResponse({
        success: false,
        message: "Invalid callback hash",
      }, 401);
    }

    // 2. Ignore pending or unsuccessful payments
    if (status !== "1") {
      return jsonResponse({
        success: true,
        message: "Payment is not successful.",
        payment_status: status,
      });
    }

    // 3. Create server-side Supabase client
    const supabase = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    // 4. Find the exact order
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        id,
        order_number,
        total,
        payment_status,
        payment_provider,
        payment_reference
      `)
      .eq("order_number", orderNumber)
      .maybeSingle();

    if (orderError) {
      throw orderError;
    }

    if (!order) {
      return jsonResponse({
        success: false,
        message: "Order not found",
      }, 404);
    }

    if (order.payment_provider !== "toyyibpay") {
      return jsonResponse({
        success: false,
        message: "Payment provider mismatch",
      }, 400);
    }

    if (order.payment_reference !== billCode) {
      return jsonResponse({
        success: false,
        message: "Bill code mismatch",
      }, 400);
    }

    // 5. Idempotency check
    const currentStatus = String(order.payment_status).toLowerCase();

    if (currentStatus === "paid") {
      return jsonResponse({
        success: true,
        message: "Order already paid",
        order_number: orderNumber,
      });
    }

    if (currentStatus !== "pending") {
      return jsonResponse({
        success: false,
        message: "Order is not pending payment",
      }, 409);
    }

    // 6. Independently verify transaction with ToyyibPay
    const transactionData = new URLSearchParams();

    transactionData.set("billCode", billCode);
    transactionData.set("userSecretKey", secretKey);
    transactionData.set("billpaymentStatus", "1");

    const transactionResponse = await fetch(
      "https://toyyibpay.com/index.php/api/getBillTransactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: transactionData.toString(),
        signal: AbortSignal.timeout(20000),
      }
    );

    if (!transactionResponse.ok) {
      throw new Error("ToyyibPay verification request failed.");
    }

    const transactionText = await transactionResponse.text();

    let transactions: unknown;

    try {
      transactions = JSON.parse(transactionText);
    } catch {
      throw new Error("Invalid ToyyibPay API response.");
    }

    if (!Array.isArray(transactions)) {
      throw new Error("ToyyibPay transaction list is unavailable.");
    }

    // 7. Match successful transaction by external order reference
    const matchingTransactions = transactions.filter(
      (item: any) =>
        String(item.billpaymentStatus) === "1" &&
        String(item.billExternalReferenceNo) === orderNumber
    );

    // More than one successful transaction for one order
    // requires manual review to avoid ambiguous payment confirmation.
    if (matchingTransactions.length !== 1) {
      return jsonResponse({
        success: false,
        message: matchingTransactions.length === 0
          ? "Successful transaction could not be verified."
          : "Multiple successful transactions found. Manual review required.",
      }, 409);
    }

    const verifiedTransaction = matchingTransactions[0];

    // 8. Verify exact payment amount in RM
    const paidCents = toCents(
      verifiedTransaction.billpaymentAmount
    );

    const orderCents = toCents(order.total);

    if (
      paidCents === null ||
      orderCents === null ||
      paidCents !== orderCents
    ) {
      return jsonResponse({
        success: false,
        message: "Payment amount does not match the order.",
      }, 409);
    }

    // 9. Update only a pending order
    const { data: updatedOrder, error: updateError } =
      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: new Date().toISOString(),
        })
        .eq("id", order.id)
        .eq("payment_status", "pending")
        .select("id, payment_status")
        .maybeSingle();

    if (updateError) {
      throw updateError;
    }

    // 10. Handle duplicate callbacks and concurrent requests
    if (!updatedOrder) {
      const { data: latestOrder, error: latestError } =
        await supabase
          .from("orders")
          .select("payment_status")
          .eq("id", order.id)
          .maybeSingle();

      if (latestError) {
        throw latestError;
      }

      if (
        latestOrder &&
        String(latestOrder.payment_status).toLowerCase() === "paid"
      ) {
        return jsonResponse({
          success: true,
          message: "Order already paid",
          order_number: orderNumber,
        });
      }

      return jsonResponse({
        success: false,
        message: "Order payment status could not be updated.",
      }, 409);
    }

    return jsonResponse({
      success: true,
      message: "Payment verified and order updated.",
      order_number: orderNumber,
      payment_status: "paid",
    });

  } catch (error) {
    console.error("ToyyibPay callback error:", error);

    return jsonResponse({
      success: false,
      message: "Callback processing failed.",
    }, 500);
  }
});

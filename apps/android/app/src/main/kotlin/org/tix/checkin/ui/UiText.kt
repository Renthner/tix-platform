package org.tix.checkin.ui

import android.content.Context
import android.text.format.DateFormat
import androidx.annotation.StringRes
import java.util.Date
import org.tix.checkin.R
import org.tix.checkin.core.contract.Iso
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.contract.SeatFeature
import org.tix.checkin.core.scan.ScanVerdict
import org.tix.checkin.core.scan.VerdictNotice

@StringRes
fun verdictHeadline(v: ScanVerdict): Int = when {
    v.notice == VerdictNotice.OFFLINE_NOT_ALLOWED -> R.string.verdict_offline_not_allowed
    v.notice == VerdictNotice.EVENT_NOT_ASSIGNED -> R.string.result_wrong_event
    else -> resultHeadline(v.result, v.action)
}

@StringRes
fun resultHeadline(result: ScanResult?, action: ScanAction): Int = when (result) {
    ScanResult.ACCEPTED -> if (action == ScanAction.CHECK_OUT) R.string.result_checked_out else R.string.result_accepted
    ScanResult.ACCEPTED_WITH_WARNING -> R.string.result_accepted_warning
    ScanResult.REJECTED_ALREADY_CHECKED_IN -> R.string.result_already_checked_in
    ScanResult.REJECTED_NOT_CHECKED_IN -> R.string.result_not_checked_in
    ScanResult.REJECTED_INVALID_SIGNATURE -> R.string.result_invalid
    ScanResult.REJECTED_WRONG_EVENT -> R.string.result_wrong_event
    ScanResult.REJECTED_TICKET_VOID -> R.string.result_void
    ScanResult.REJECTED_UNKNOWN_TICKET -> R.string.result_unknown_ticket
    ScanResult.REJECTED_MALFORMED -> R.string.result_malformed
    ScanResult.REJECTED_CHECK_OUT_NOT_ALLOWED -> R.string.result_check_out_not_allowed
    ScanResult.UNKNOWN, null -> R.string.result_rejected
}

/** Text of a warning: the server/manifest text when there is one, otherwise the app's own. */
fun warningText(context: Context, v: ScanVerdict, w: ScanWarning): String {
    v.warningTexts[w.name]?.takeIf { it.isNotBlank() }?.let { return it }
    return when (w) {
        ScanWarning.DISCOUNT_PROOF_REQUIRED -> context.getString(R.string.warning_proof)
        ScanWarning.WRONG_ENTRANCE -> context.getString(R.string.warning_entrance)
        ScanWarning.SEAT_FEATURE -> context.getString(seatFeatureLabel(v.ticket?.seatFeature))
        ScanWarning.ADDITIONAL_PAYMENT_OPEN -> context.getString(R.string.warning_additional_payment)
        ScanWarning.UNKNOWN -> context.getString(R.string.warning_other)
    }
}

@StringRes
fun seatFeatureLabel(f: SeatFeature?): Int = when (f) {
    SeatFeature.WHEELCHAIR_SPACE -> R.string.seat_wheelchair
    SeatFeature.COMPANION_SEAT -> R.string.seat_companion
    else -> R.string.warning_other
}

/** Local date and time of an ISO timestamp from the server; empty when unparsable. */
fun formatTime(context: Context, iso: String?): String {
    val ms = Iso.parseMillis(iso) ?: return ""
    return formatMillis(context, ms)
}

fun formatMillis(context: Context, ms: Long): String {
    val d = Date(ms)
    return DateFormat.getMediumDateFormat(context).format(d) + " " + DateFormat.getTimeFormat(context).format(d)
}

-- CreateIndex
CREATE INDEX "VisitAuditLog_performedById_idx" ON "VisitAuditLog"("performedById");

-- AddForeignKey
ALTER TABLE "VisitAuditLog" ADD CONSTRAINT "VisitAuditLog_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
